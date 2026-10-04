import { DBRef, ObjectId } from 'mongodb';
import type { CollectionSummary, ReadOnlyMongo } from './client';

export interface FieldInfo {
  path: string;
  /** Tipos vistos en la muestra, del mas frecuente al menos. */
  types: string[];
  /** Porcentaje de documentos de la muestra que traen el campo. */
  presence: number;
  /** Un valor real, para que el modelo sepa que forma tiene. */
  example?: string | undefined;
}

export interface CollectionSchema {
  collection: string;
  sampled: number;
  fields: FieldInfo[];
}

/** Profundidad a la que se baja dentro de los objetos anidados. */
const MAX_DEPTH = 2;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof ObjectId) return 'objectId';
  if (value instanceof DBRef) return 'dbref';
  return typeof value;
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ObjectId) return String(value);
  // El driver expone un DBRef como objeto JS con .oid/.namespace, pero dentro
  // de BSON los campos se llaman $id/$ref/$db, que es como hay que filtrarlos.
  if (value instanceof DBRef) {
    const ref = value as unknown as { namespace: string; oid: unknown };
    return `referencia a ${ref.namespace} (${String(ref.oid)})`;
  }
  if (Array.isArray(value)) return `[${value.length} elementos]`;
  if (typeof value === 'object') return '{...}';

  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/** Recorre un documento acumulando que campos aparecen y de que tipo. */
function walk(
  document: Record<string, unknown>,
  seen: Map<string, { types: Map<string, number>; count: number; example?: unknown }>,
  prefix = '',
  depth = 0,
): void {
  for (const [key, value] of Object.entries(document)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const entry = seen.get(path) ?? { types: new Map<string, number>(), count: 0 };

    const type = typeOf(value);
    entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
    entry.count++;
    if (entry.example === undefined && value !== null && value !== undefined) {
      entry.example = value;
    }
    seen.set(path, entry);

    // Se baja solo un par de niveles: mas profundidad llena el contexto de ruido.
    // En un DBRef no se entra: sus propiedades JS (oid, namespace) no son los
    // nombres reales de BSON, y ensenyarlas hace que el modelo filtre por
    // campos que no existen.
    const isPlainObject =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !(value instanceof ObjectId) &&
      !(value instanceof DBRef);

    if (isPlainObject && depth < MAX_DEPTH) {
      walk(value as Record<string, unknown>, seen, path, depth + 1);
    }
  }
}

/**
 * Infiere la forma de una coleccion a partir de una muestra.
 *
 * MongoDB no tiene esquema, asi que esto es lo unico que puede evitar que el
 * modelo se invente nombres de campo. La presencia importa tanto como el tipo:
 * un campo que sale en el 12% de los documentos no sirve para filtrar.
 */
export async function describeCollection(
  mongo: ReadOnlyMongo,
  collection: string,
  sampleSize: number,
): Promise<CollectionSchema> {
  const documents = await mongo.sample(collection, sampleSize);
  const seen = new Map<string, { types: Map<string, number>; count: number; example?: unknown }>();

  for (const document of documents) walk(document, seen);

  const fields: FieldInfo[] = [...seen.entries()]
    .map(([path, entry]) => {
      const example = preview(entry.example);
      return {
        path,
        types: [...entry.types.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type),
        presence: documents.length === 0 ? 0 : Math.round((entry.count / documents.length) * 100),
        ...(example ? { example } : {}),
      };
    })
    .sort((a, b) => b.presence - a.presence || a.path.localeCompare(b.path));

  return { collection, sampled: documents.length, fields };
}

/**
 * Catalogo compacto para el prompt de sistema. Una linea por coleccion: lo
 * justo para que el modelo sepa que existe sin gastar medio contexto.
 */
export function summarizeCollections(
  database: string,
  collections: CollectionSummary[],
): string {
  if (collections.length === 0) {
    return `La base MongoDB "${database}" no tiene colecciones visibles.`;
  }

  const lines = collections.map(
    collection => `- ${collection.name} (~${collection.documents.toLocaleString('es-ES')} documentos)`,
  );
  return (
    `Colecciones de la base MongoDB "${database}" (${collections.length}). ` +
    `Estas son TODAS las que existen:\n${lines.join('\n')}`
  );
}
