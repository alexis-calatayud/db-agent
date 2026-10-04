import { ObjectId } from 'mongodb';
import { Tool, tool } from 'smolagents.js';
import type { DocumentsResult, ReadOnlyMongo } from '../mongo/client';
import { UnsafeMongoError, parseJsonArgument } from '../mongo/guard';
import { describeCollection } from '../mongo/introspect';

/** Tope de caracteres por respuesta, para no reventar el contexto. */
const MAX_OUTPUT_CHARS = 6000;

/** `JSON.stringify` no sabe serializar los tipos propios de BSON. */
function toJsonSafe(value: unknown): unknown {
  if (value instanceof ObjectId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        toJsonSafe(nested),
      ]),
    );
  }
  return value;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[...salida recortada. Proyecta menos campos, filtra mas o agrega con mongo_aggregate.]`;
}

/** Convierte cualquier fallo en texto que el modelo pueda leer y corregir. */
function toObservation(error: unknown): string {
  if (error instanceof UnsafeMongoError) return `Consulta rechazada: ${error.message}`;
  const message = error instanceof Error ? error.message : String(error);
  return `Error de MongoDB: ${message}`;
}

function renderDocuments(result: DocumentsResult, maxDocuments: number): string {
  if (result.documents.length === 0) return 'La consulta no ha devuelto ningun documento.';

  const header = result.truncated
    ? `${result.documents.length} documentos (recortado al limite de ${maxDocuments}; hay mas):`
    : `${result.documents.length} documento${result.documents.length === 1 ? '' : 's'}:`;

  return truncate(`${header}\n${JSON.stringify(result.documents.map(toJsonSafe))}`);
}

/** Nota comun: como se expresan fechas e identificadores en los filtros. */
const BSON_HINT =
  'Para fechas usa {"$date": "2026-01-01T00:00:00Z"} y para identificadores ' +
  '{"$oid": "507f1f77bcf86cd799439011"}.';

export function makeMongoListCollectionsTool(mongo: ReadOnlyMongo): Tool {
  return tool(
    {
      name: 'mongo_list_collections',
      description:
        `Lista las colecciones de la base MongoDB "${mongo.databaseName}" con su numero aproximado ` +
        'de documentos. El catalogo ya esta en tus instrucciones, asi que solo hace falta llamarla ' +
        'si sospechas que ha cambiado. No acepta parametros.',
      inputs: {},
      outputType: 'string',
    },
    async (): Promise<string> => {
      try {
        const collections = await mongo.listCollections();
        if (collections.length === 0) return 'No hay colecciones en esta base.';

        const lines = collections.map(
          collection =>
            `${collection.name} - ~${collection.documents.toLocaleString('es-ES')} documentos`,
        );
        return truncate(`${collections.length} colecciones:\n${lines.join('\n')}`);
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

export function makeMongoDescribeCollectionTool(mongo: ReadOnlyMongo, sampleSize: number): Tool {
  return tool(
    {
      name: 'mongo_describe_collection',
      description:
        'Infiere la forma de una coleccion muestreando documentos: campos, tipos, en que porcentaje ' +
        'de documentos aparece cada uno y un valor de ejemplo. MongoDB no tiene esquema, asi que ' +
        'llamala SIEMPRE antes de consultar una coleccion que no conozcas: es la unica forma de no ' +
        'inventarte nombres de campo.',
      inputs: {
        collection: {
          type: 'string',
          description: 'Nombre de la coleccion. Ejemplo: "artworks".',
        },
      },
      outputType: 'string',
    },
    async ({ collection }: { collection: string }): Promise<string> => {
      try {
        const name = collection?.trim();
        if (!name) return 'Falta el nombre de la coleccion.';

        const schema = await describeCollection(mongo, name, sampleSize);
        if (schema.sampled === 0) {
          return `La coleccion "${name}" esta vacia o no existe. Usa mongo_list_collections para ver las que hay.`;
        }

        const lines = schema.fields.map(field => {
          const types = field.types.join(' | ');
          const example = field.example ? `  ej: ${field.example}` : '';
          return `  ${field.path}: ${types}  (${field.presence}%)${example}`;
        });

        // Los DBRef se guardan como {$ref, $id, $db}. Sin esta nota el modelo
        // filtra por propiedades del objeto JS que no existen en BSON, y luego
        // choca contra la regla de que un FieldPath no puede empezar por '$'.
        const refs = schema.fields.filter(field => field.types.includes('dbref'));
        const first = refs[0]?.path ?? 'campo';
        const warning =
          refs.length > 0
            ? '\n\nAtencion: ' +
              refs.map(field => `"${field.path}"`).join(', ') +
              ` ${refs.length === 1 ? 'es una referencia (DBRef)' : 'son referencias (DBRef)'}, ` +
              'guardada como {$ref, $id, $db}. Se consulta distinto segun la herramienta:\n' +
              `  - mongo_find: filtra con {"${first}.$id": {"$oid": "..."}}. Funciona.\n` +
              `  - mongo_aggregate: NO puedes escribir "$${first}.$id" en una expresion; MongoDB ` +
              'rechaza los FieldPath que empiezan por "$". Para agrupar por la referencia usa:\n' +
              `    [{"$project": {"kv": {"$objectToArray": "$${first}"}}},\n` +
              '     {"$project": {"ref": {"$arrayElemAt": [{"$filter": {"input": "$kv", "cond": {"$eq": ["$$this.k", "$id"]}}}, 0]}}},\n' +
              '     {"$group": {"_id": "$ref.v"}}]'
            : '';

        return truncate(
          `${name} — inferido de ${schema.sampled} documentos de muestra.\n` +
            'El porcentaje es en cuantos documentos aparece el campo: si es bajo, no sirve para filtrar.\n' +
            lines.join('\n') +
            warning,
        );
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

export function makeMongoFindTool(mongo: ReadOnlyMongo, maxDocuments: number): Tool {
  return tool(
    {
      name: 'mongo_find',
      description:
        'Consulta documentos de una coleccion de MongoDB. Es de SOLO LECTURA: no puede escribir ni ' +
        'borrar. Los argumentos JSON van como texto. ' +
        `Devuelve como mucho ${maxDocuments} documentos, asi que proyecta solo los campos que ` +
        'necesites y filtra bien; para contar o agrupar usa mongo_aggregate. ' +
        BSON_HINT,
      inputs: {
        collection: { type: 'string', description: 'Nombre de la coleccion.' },
        filter: {
          type: 'string',
          description: 'Filtro en JSON. Ejemplo: {"estado": "activo", "precio": {"$gt": 100}}. Omitelo para todos.',
          nullable: true,
        },
        projection: {
          type: 'string',
          description: 'Campos a devolver, en JSON. Ejemplo: {"nombre": 1, "precio": 1, "_id": 0}.',
          nullable: true,
        },
        sort: {
          type: 'string',
          description: 'Orden en JSON. Ejemplo: {"fecha": -1} para descendente.',
          nullable: true,
        },
        limit: {
          // 'number' y no 'integer': smolagents valida con typeof, y con
          // 'integer' la llamada se rechaza siempre.
          type: 'number',
          description: `Maximo de documentos, entero. Tope ${maxDocuments}.`,
          nullable: true,
        },
      },
      outputType: 'string',
    },
    async ({
      collection,
      filter,
      projection,
      sort,
      limit,
    }: {
      collection: string;
      filter?: string | null;
      projection?: string | null;
      sort?: string | null;
      limit?: number | null;
    }): Promise<string> => {
      try {
        const name = collection?.trim();
        if (!name) return 'Falta el nombre de la coleccion.';

        const result = await mongo.find(name, {
          filter: parseJsonArgument(filter, 'El filtro') ?? {},
          ...(projection ? { projection: parseJsonArgument(projection, 'La proyeccion') } : {}),
          ...(sort ? { sort: parseJsonArgument(sort, 'El orden') } : {}),
          ...(limit ? { limit } : {}),
        });

        return renderDocuments(result, maxDocuments);
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

export function makeMongoAggregateTool(mongo: ReadOnlyMongo, maxDocuments: number): Tool {
  return tool(
    {
      name: 'mongo_aggregate',
      description:
        'Ejecuta un pipeline de agregacion de SOLO LECTURA sobre una coleccion de MongoDB. ' +
        'Usala para contar, agrupar, calcular medias o cruzar colecciones con $lookup. ' +
        'Las etapas que escriben ($out, $merge) y las que ejecutan JavaScript ($where, $function) ' +
        'estan prohibidas. El pipeline va como texto JSON. ' +
        'Ejemplo: [{"$group": {"_id": "$estado", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}]. ' +
        BSON_HINT,
      inputs: {
        collection: { type: 'string', description: 'Nombre de la coleccion.' },
        pipeline: { type: 'string', description: 'Array de etapas en JSON.' },
        limit: {
          type: 'number',
          description: `Maximo de documentos devueltos, entero. Tope ${maxDocuments}.`,
          nullable: true,
        },
      },
      outputType: 'string',
    },
    async ({
      collection,
      pipeline,
      limit,
    }: {
      collection: string;
      pipeline: string;
      limit?: number | null;
    }): Promise<string> => {
      try {
        const name = collection?.trim();
        if (!name) return 'Falta el nombre de la coleccion.';

        const stages = parseJsonArgument(pipeline, 'El pipeline');
        if (stages === undefined) return 'Falta el pipeline.';

        const result = await mongo.aggregate(name, stages, limit ?? undefined);
        return renderDocuments(result, maxDocuments);
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

/** Las cuatro tools de MongoDB, listas para el agente. */
export function makeMongoTools(
  mongo: ReadOnlyMongo,
  maxDocuments: number,
  sampleSize: number,
): Tool[] {
  return [
    makeMongoListCollectionsTool(mongo),
    makeMongoDescribeCollectionTool(mongo, sampleSize),
    makeMongoFindTool(mongo, maxDocuments),
    makeMongoAggregateTool(mongo, maxDocuments),
  ];
}
