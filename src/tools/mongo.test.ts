import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { ReadOnlyMongo } from '../mongo/client';
import { assertReadOnlyFilter, assertReadOnlyPipeline } from '../mongo/guard';
import {
  makeMongoAggregateTool,
  makeMongoDescribeCollectionTool,
  makeMongoFindTool,
  makeMongoListCollectionsTool,
} from './mongo';

/**
 * Doble del cliente. Las validaciones se delegan al guard de verdad, para que
 * estos tests comprueben tambien que las tools no se lo saltan.
 */
function fakeMongo(overrides: Partial<ReadOnlyMongo> = {}): ReadOnlyMongo {
  return {
    databaseName: 'base_de_prueba',
    listCollections: async () => [],
    sample: async () => [],
    find: async (_collection: string, options: { filter?: unknown } = {}) => {
      assertReadOnlyFilter(options.filter ?? {});
      return { documents: [], truncated: false };
    },
    aggregate: async (_collection: string, pipeline: unknown) => {
      assertReadOnlyPipeline(pipeline);
      return { documents: [], truncated: false };
    },
    countDocuments: async () => 0,
    close: async () => {},
    ...overrides,
  } as unknown as ReadOnlyMongo;
}

describe('mongo_list_collections', () => {
  it('lista con el numero de documentos', async () => {
    const mongo = fakeMongo({
      listCollections: async () => [
        { name: 'artworks', documents: 30633 },
        { name: 'users', documents: 5509 },
      ],
    });

    const output = await makeMongoListCollectionsTool(mongo).call({});
    expect(output).toContain('2 colecciones');
    expect(output).toContain('artworks');
    expect(output).toContain('30.633');
  });

  it('lo dice si no hay colecciones', async () => {
    expect(await makeMongoListCollectionsTool(fakeMongo()).call({})).toContain('No hay colecciones');
  });

  it('nombra la base en su descripcion, para no confundirla con Postgres', () => {
    expect(makeMongoListCollectionsTool(fakeMongo()).description).toContain('base_de_prueba');
  });
});

describe('mongo_describe_collection', () => {
  it('infiere campos, tipos y presencia de la muestra', async () => {
    const mongo = fakeMongo({
      sample: async () => [
        { _id: new ObjectId(), titulo: 'Cuadro', precio: 100 },
        { _id: new ObjectId(), titulo: 'Otro' },
      ],
    });

    const output = await makeMongoDescribeCollectionTool(mongo, 100).call({ collection: 'artworks' });

    expect(output).toContain('_id: objectId  (100%)');
    expect(output).toContain('titulo: string  (100%)');
    // precio solo esta en uno de los dos: la presencia debe reflejarlo.
    expect(output).toContain('precio: number  (50%)');
  });

  it('avisa cuando la coleccion esta vacia o no existe', async () => {
    const output = await makeMongoDescribeCollectionTool(fakeMongo(), 100).call({
      collection: 'fantasma',
    });

    expect(output).toContain('vacia o no existe');
    expect(output).toContain('mongo_list_collections');
  });

  it('explica como consultar un DBRef, que se pregunta distinto en find y en aggregate', async () => {
    const { DBRef } = await import('mongodb');
    const mongo = fakeMongo({
      sample: async () => [{ artist: new DBRef('artists', new ObjectId()) }],
    });

    const output = await makeMongoDescribeCollectionTool(mongo, 100).call({ collection: 'artworks' });

    expect(output).toContain('artist: dbref');
    expect(output).toContain('"artist.$id"');       // asi si, en find
    expect(output).toContain('$objectToArray');      // el rodeo para aggregate
    expect(output).toContain('empiezan por "$"');    // y por que hace falta
  });

  it('no se mete dentro del DBRef: .oid y .namespace no existen en BSON', async () => {
    const { DBRef } = await import('mongodb');
    const mongo = fakeMongo({
      sample: async () => [{ artist: new DBRef('artists', new ObjectId()) }],
    });

    const output = await makeMongoDescribeCollectionTool(mongo, 100).call({ collection: 'artworks' });

    expect(output).not.toContain('artist.oid');
    expect(output).not.toContain('artist.namespace');
    expect(output).not.toContain('_bsontype');
  });

  it('exige el nombre de la coleccion', async () => {
    expect(
      await makeMongoDescribeCollectionTool(fakeMongo(), 100).call({ collection: '  ' }),
    ).toContain('Falta el nombre');
  });
});

describe('mongo_find', () => {
  it('devuelve los documentos en JSON', async () => {
    const mongo = fakeMongo({
      find: async () => ({ documents: [{ titulo: 'Cuadro', precio: 100 }], truncated: false }),
    });

    const output = await makeMongoFindTool(mongo, 50).call({ collection: 'artworks' });
    expect(output).toContain('1 documento');
    expect(output).toContain('"titulo":"Cuadro"');
  });

  it('serializa ObjectId y Date sin romperse', async () => {
    const mongo = fakeMongo({
      find: async () => ({
        documents: [
          { _id: new ObjectId('507f1f77bcf86cd799439011'), creado: new Date('2026-01-01T00:00:00Z') },
        ],
        truncated: false,
      }),
    });

    const output = await makeMongoFindTool(mongo, 50).call({ collection: 'x' });
    expect(output).toContain('507f1f77bcf86cd799439011');
    expect(output).toContain('2026-01-01T00:00:00.000Z');
  });

  it('avisa cuando el resultado se ha recortado', async () => {
    const mongo = fakeMongo({
      find: async () => ({ documents: [{ a: 1 }], truncated: true }),
    });

    expect(await makeMongoFindTool(mongo, 50).call({ collection: 'x' })).toContain('recortado');
  });

  it('pasa el filtro por el validador: rechaza $where', async () => {
    const output = await makeMongoFindTool(fakeMongo(), 50).call({
      collection: 'x',
      filter: '{"$where": "true"}',
    });

    expect(output).toStartWith('Consulta rechazada:');
    expect(output).toContain('$where');
  });

  it('explica un JSON mal formado', async () => {
    const output = await makeMongoFindTool(fakeMongo(), 50).call({
      collection: 'x',
      filter: '{roto',
    });

    expect(output).toContain('no es JSON valido');
  });

  it('convierte $oid del filtro en un ObjectId de verdad', async () => {
    let received: unknown;
    const mongo = fakeMongo({
      find: async (_c: string, options: { filter?: unknown } = {}) => {
        received = options.filter;
        return { documents: [], truncated: false };
      },
    });

    await makeMongoFindTool(mongo, 50).call({
      collection: 'x',
      filter: '{"_id": {"$oid": "507f1f77bcf86cd799439011"}}',
    });

    expect((received as { _id: unknown })._id).toBeInstanceOf(ObjectId);
  });
});

describe('mongo_aggregate', () => {
  it('ejecuta pipelines de lectura', async () => {
    const mongo = fakeMongo({
      aggregate: async () => ({ documents: [{ _id: 'activo', n: 12 }], truncated: false }),
    });

    const output = await makeMongoAggregateTool(mongo, 50).call({
      collection: 'x',
      pipeline: '[{"$group": {"_id": "$estado", "n": {"$sum": 1}}}]',
    });

    expect(output).toContain('"n":12');
  });

  it('rechaza las etapas que escriben', async () => {
    for (const stage of ['[{"$out": "copia"}]', '[{"$merge": {"into": "copia"}}]']) {
      const output = await makeMongoAggregateTool(fakeMongo(), 50).call({
        collection: 'x',
        pipeline: stage,
      });
      expect(output).toStartWith('Consulta rechazada:');
    }
  });

  it('rechaza un $out escondido dentro de un $facet', async () => {
    const output = await makeMongoAggregateTool(fakeMongo(), 50).call({
      collection: 'x',
      pipeline: '[{"$facet": {"a": [{"$out": "copia"}]}}]',
    });

    expect(output).toStartWith('Consulta rechazada:');
    expect(output).toContain('$out');
  });

  it('exige el pipeline', async () => {
    expect(await makeMongoAggregateTool(fakeMongo(), 50).call({ collection: 'x', pipeline: '' }))
      .toContain('Falta el pipeline');
  });
});

describe('esquema de argumentos', () => {
  it('los limites se declaran como "number", nunca como "integer"', () => {
    // 'integer' hace que smolagents rechace siempre la llamada.
    expect(makeMongoFindTool(fakeMongo(), 50).inputs['limit']?.['type']).toBe('number');
    expect(makeMongoAggregateTool(fakeMongo(), 50).inputs['limit']?.['type']).toBe('number');
  });

  it('los argumentos opcionales van marcados como nullable', () => {
    const find = makeMongoFindTool(fakeMongo(), 50);
    for (const key of ['filter', 'projection', 'sort', 'limit']) {
      expect(find.inputs[key]?.['nullable']).toBe(true);
    }
    expect(find.inputs['collection']?.['nullable']).toBeUndefined();
  });
});

describe('resistencia a fallos', () => {
  it('un error del driver se devuelve como observacion, no tumba el turno', async () => {
    const roto = fakeMongo({
      find: async () => {
        throw new Error('connection refused');
      },
      listCollections: async () => {
        throw new Error('connection refused');
      },
    });

    expect(await makeMongoFindTool(roto, 50).call({ collection: 'x' })).toContain(
      'Error de MongoDB: connection refused',
    );
    expect(await makeMongoListCollectionsTool(roto).call({})).toContain('Error de MongoDB');
  });
});
