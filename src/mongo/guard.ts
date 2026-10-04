import { ObjectId } from 'mongodb';

/**
 * Barrera de solo-lectura para lo que el modelo manda a MongoDB.
 *
 * Ojo a la diferencia con Postgres: alli la segunda barrera era una transaccion
 * `READ ONLY` que rechazaba el propio servidor. MongoDB 3.4 no tiene nada
 * equivalente, asi que aqui las dos barreras son (1) este validador y (2) que
 * el cliente no expone ni una sola operacion de escritura del driver. No es lo
 * mismo: por eso conviene ademas un usuario de Mongo con rol `read`.
 */

export class UnsafeMongoError extends Error {
  override readonly name = 'UnsafeMongoError';
}

/**
 * Operadores prohibidos en cualquier posicion, por muy anidados que vayan.
 *
 * - `$out` y `$merge` escriben una coleccion desde una agregacion.
 * - `$where`, `$function`, `$accumulator` y `$eval` ejecutan JavaScript en el
 *   servidor: ademas de poder escribir, son ejecucion de codigo arbitrario.
 */
const FORBIDDEN_OPERATORS = new Set([
  '$out',
  '$merge',
  '$where',
  '$function',
  '$accumulator',
  '$eval',
]);

/**
 * Etapas permitidas al principio de cada paso del pipeline.
 *
 * Es una lista blanca a proposito: la lista negra de arriba cubre lo que hoy
 * escribe, pero una version futura de MongoDB podria anyadir otra etapa de
 * escritura y aqui no entraria sola.
 */
const ALLOWED_STAGES = new Set([
  '$addFields',
  '$bucket',
  '$bucketAuto',
  '$collStats',
  '$count',
  '$densify',
  '$facet',
  '$fill',
  '$geoNear',
  '$graphLookup',
  '$group',
  '$indexStats',
  '$limit',
  '$lookup',
  '$match',
  '$project',
  '$redact',
  '$replaceRoot',
  '$replaceWith',
  '$sample',
  '$set',
  '$setWindowFields',
  '$skip',
  '$sort',
  '$sortByCount',
  '$unionWith',
  '$unset',
  '$unwind',
]);

/** Recorre la estructura entera buscando operadores prohibidos. */
function assertNoForbiddenOperators(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenOperators(item, `${path}[${index}]`));
    return;
  }

  if (value === null || typeof value !== 'object') return;
  // Date, ObjectId y demas tipos BSON no llevan operadores dentro.
  if (value instanceof Date || value instanceof ObjectId) return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      throw new UnsafeMongoError(
        `"${key}" no esta permitido en modo solo lectura` +
          (path ? ` (aparece en ${path})` : '') +
          '. Escribe o ejecuta codigo en el servidor.',
      );
    }
    assertNoForbiddenOperators(nested, path ? `${path}.${key}` : key);
  }
}

/** Valida un filtro de `find`. */
export function assertReadOnlyFilter(filter: unknown): void {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new UnsafeMongoError('El filtro debe ser un objeto JSON, por ejemplo {"activo": true}.');
  }
  assertNoForbiddenOperators(filter);
}

/** Valida un pipeline de agregacion completo. */
export function assertReadOnlyPipeline(pipeline: unknown): asserts pipeline is object[] {
  if (!Array.isArray(pipeline)) {
    throw new UnsafeMongoError('El pipeline debe ser un array de etapas.');
  }
  if (pipeline.length === 0) {
    throw new UnsafeMongoError('El pipeline esta vacio.');
  }

  pipeline.forEach((stage, index) => {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new UnsafeMongoError(`La etapa ${index + 1} del pipeline no es un objeto.`);
    }

    const keys = Object.keys(stage as Record<string, unknown>);
    if (keys.length !== 1) {
      throw new UnsafeMongoError(
        `La etapa ${index + 1} debe tener exactamente un operador, pero tiene ${keys.length}.`,
      );
    }

    const stageName = keys[0]!;
    if (!ALLOWED_STAGES.has(stageName)) {
      throw new UnsafeMongoError(
        `La etapa "${stageName}" no esta permitida en modo solo lectura. ` +
          `Permitidas: ${[...ALLOWED_STAGES].sort().join(', ')}.`,
      );
    }
  });

  assertNoForbiddenOperators(pipeline);
}

/**
 * Convierte `{"$date": "..."}` en Date y `{"$oid": "..."}` en ObjectId.
 *
 * El bson que trae el driver 3.x no incluye EJSON, y sin esto no se pueden
 * filtrar fechas ni identificadores, que es la mitad de las consultas utiles.
 */
function reviveBson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveBson);
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length === 1) {
    const [key, raw] = entries[0]!;

    if (key === '$date' && (typeof raw === 'string' || typeof raw === 'number')) {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) {
        throw new UnsafeMongoError(`Fecha invalida en $date: ${JSON.stringify(raw)}.`);
      }
      return date;
    }

    if (key === '$oid' && typeof raw === 'string') {
      if (!/^[0-9a-fA-F]{24}$/.test(raw)) {
        throw new UnsafeMongoError(`ObjectId invalido en $oid: "${raw}". Deben ser 24 hex.`);
      }
      return new ObjectId(raw);
    }
  }

  return Object.fromEntries(entries.map(([key, nested]) => [key, reviveBson(nested)]));
}

/**
 * Parsea un argumento JSON del modelo.
 *
 * Se reciben como texto y no como objeto para que un JSON mal formado devuelva
 * un error concreto que el modelo pueda corregir, en vez de chocar contra la
 * validacion de tipos de smolagents.
 */
export function parseJsonArgument(raw: string | null | undefined, what: string): unknown {
  const text = raw?.trim();
  if (!text) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UnsafeMongoError(
      `${what} no es JSON valido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return reviveBson(parsed);
}
