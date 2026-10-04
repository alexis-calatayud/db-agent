import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  UnsafeMongoError,
  assertReadOnlyFilter,
  assertReadOnlyPipeline,
  parseJsonArgument,
} from './guard';

const rejectsPipeline = (stages: unknown) =>
  expect(() => assertReadOnlyPipeline(stages)).toThrow(UnsafeMongoError);
const acceptsPipeline = (stages: unknown) =>
  expect(() => assertReadOnlyPipeline(stages)).not.toThrow();

describe('pipelines: lectura legitima', () => {
  it('acepta las etapas habituales de analisis', () => {
    acceptsPipeline([{ $match: { estado: 'activo' } }]);
    acceptsPipeline([{ $group: { _id: '$tipo', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
    acceptsPipeline([{ $lookup: { from: 'artists', localField: 'a', foreignField: '_id', as: 'x' } }]);
    acceptsPipeline([{ $unwind: '$tags' }, { $count: 'total' }]);
    acceptsPipeline([{ $facet: { porTipo: [{ $group: { _id: '$tipo' } }] } }]);
  });

  it('acepta $expr, que no ejecuta JavaScript', () => {
    acceptsPipeline([{ $match: { $expr: { $gt: ['$precio', '$coste'] } } }]);
  });
});

describe('pipelines: escritura y ejecucion de codigo', () => {
  it('rechaza las etapas que escriben', () => {
    rejectsPipeline([{ $out: 'copia' }]);
    rejectsPipeline([{ $merge: { into: 'copia' } }]);
    rejectsPipeline([{ $match: {} }, { $out: 'copia' }]);
  });

  it('rechaza la ejecucion de JavaScript en el servidor', () => {
    rejectsPipeline([{ $match: { $where: 'this.precio > 100' } }]);
    rejectsPipeline([{ $group: { _id: null, x: { $accumulator: { init: 'function(){}' } } } }]);
    rejectsPipeline([{ $project: { x: { $function: { body: 'function(){}', args: [], lang: 'js' } } } }]);
  });

  /** Lo que hace falta que el validador recorra la estructura entera. */
  it('rechaza un $out escondido dentro de un $facet', () => {
    rejectsPipeline([{ $facet: { a: [{ $out: 'copia' }] } }]);
  });

  it('rechaza un $where anidado en profundidad', () => {
    rejectsPipeline([{ $match: { $and: [{ activo: true }, { $where: 'true' }] } }]);
  });

  it('senyala donde esta el operador prohibido', () => {
    expect(() => assertReadOnlyPipeline([{ $facet: { a: [{ $out: 'x' }] } }])).toThrow(
      /\[0\]\.\$facet\.a\[0\]/,
    );
  });

  it('rechaza una etapa desconocida en vez de dejarla pasar', () => {
    // Lista blanca: una etapa de escritura futura no entraria sola.
    rejectsPipeline([{ $etapaQueNoExiste: {} }]);
  });
});

describe('pipelines: forma', () => {
  it('exige un array con al menos una etapa', () => {
    rejectsPipeline({ $match: {} });
    rejectsPipeline([]);
    rejectsPipeline('[]');
  });

  it('exige un unico operador por etapa', () => {
    rejectsPipeline([{ $match: {}, $sort: {} }]);
    rejectsPipeline([null]);
    rejectsPipeline([['$match']]);
  });
});

describe('filtros de find', () => {
  it('acepta filtros normales', () => {
    expect(() => assertReadOnlyFilter({})).not.toThrow();
    expect(() => assertReadOnlyFilter({ precio: { $gt: 100 } })).not.toThrow();
    expect(() => assertReadOnlyFilter({ _id: new ObjectId() })).not.toThrow();
    expect(() => assertReadOnlyFilter({ creado: { $gte: new Date() } })).not.toThrow();
  });

  it('rechaza $where en cualquier nivel', () => {
    expect(() => assertReadOnlyFilter({ $where: 'true' })).toThrow(UnsafeMongoError);
    expect(() => assertReadOnlyFilter({ $or: [{ $where: 'true' }] })).toThrow(UnsafeMongoError);
  });

  it('exige que sea un objeto', () => {
    expect(() => assertReadOnlyFilter('activo')).toThrow(UnsafeMongoError);
    expect(() => assertReadOnlyFilter([{ a: 1 }])).toThrow(UnsafeMongoError);
    expect(() => assertReadOnlyFilter(null)).toThrow(UnsafeMongoError);
  });
});

describe('parseJsonArgument', () => {
  it('devuelve undefined si no hay nada', () => {
    expect(parseJsonArgument(undefined, 'x')).toBeUndefined();
    expect(parseJsonArgument(null, 'x')).toBeUndefined();
    expect(parseJsonArgument('   ', 'x')).toBeUndefined();
  });

  it('explica un JSON mal formado en vez de reventar', () => {
    expect(() => parseJsonArgument('{no soy json}', 'El filtro')).toThrow(/El filtro no es JSON/);
  });

  // El bson del driver 3.x no trae EJSON: sin esto no se puede filtrar por
  // fecha ni por identificador, que es la mitad de las consultas utiles.
  it('convierte $date en Date', () => {
    const parsed = parseJsonArgument('{"creado": {"$date": "2026-01-01T00:00:00Z"}}', 'x') as {
      creado: Date;
    };
    expect(parsed.creado).toBeInstanceOf(Date);
    expect(parsed.creado.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('convierte $oid en ObjectId', () => {
    const parsed = parseJsonArgument('{"_id": {"$oid": "507f1f77bcf86cd799439011"}}', 'x') as {
      _id: ObjectId;
    };
    expect(parsed._id).toBeInstanceOf(ObjectId);
    expect(String(parsed._id)).toBe('507f1f77bcf86cd799439011');
  });

  it('convierte tambien en estructuras anidadas', () => {
    const parsed = parseJsonArgument(
      '{"$and": [{"f": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}]}',
      'x',
    ) as { $and: Array<{ f: { $gte: Date } }> };
    expect(parsed.$and[0]!.f.$gte).toBeInstanceOf(Date);
  });

  it('rechaza fechas e identificadores invalidos', () => {
    expect(() => parseJsonArgument('{"f": {"$date": "no es fecha"}}', 'x')).toThrow(/Fecha invalida/);
    expect(() => parseJsonArgument('{"_id": {"$oid": "corto"}}', 'x')).toThrow(/ObjectId invalido/);
  });

  it('no toca un objeto que solo se parece', () => {
    const parsed = parseJsonArgument('{"a": {"$date": "x", "otro": 1}}', 'x') as {
      a: Record<string, unknown>;
    };
    // Con dos claves ya no es una fecha extendida: se deja tal cual.
    expect(parsed.a['otro']).toBe(1);
  });
});
