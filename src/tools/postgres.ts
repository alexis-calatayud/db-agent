import { Tool, tool } from 'smolagents.js';
import type { ReadOnlyDatabase } from '../db/client';
import { UnsafeQueryError } from '../db/guard';
import { describeTable, listTables } from '../db/introspect';

/** Tope de caracteres por respuesta de tool, para no reventar el contexto. */
const MAX_OUTPUT_CHARS = 6000;

/**
 * `JSON.stringify` no sabe serializar los BigInt que Postgres devuelve para
 * `bigint` y `count(*)`, ni los Buffer de `bytea`.
 */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}

function serializeRows(rows: Array<Record<string, unknown>>): string {
  const plain = rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = toJsonSafe(value);
    return out;
  });
  return JSON.stringify(plain);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[...salida recortada. Acota la consulta con menos columnas, un WHERE mas estrecho o una agregacion.]`;
}

/** Convierte cualquier fallo en texto que el modelo pueda leer y corregir. */
function toObservation(error: unknown): string {
  if (error instanceof UnsafeQueryError) return `Consulta rechazada: ${error.message}`;
  const message = error instanceof Error ? error.message : String(error);
  return `Error de la base de datos: ${message}`;
}

/** Tool 1: que tablas hay. */
export function makeListTablesTool(db: ReadOnlyDatabase, schemas: string[]): Tool {
  return tool(
    {
      name: 'list_tables',
      description:
        'Lista las tablas y vistas disponibles en la base de datos, con su numero de columnas, ' +
        'filas aproximadas y tamano. Usala siempre primero, antes de escribir cualquier consulta, ' +
        'para saber que existe realmente. No acepta parametros.',
      inputs: {},
      outputType: 'string',
    },
    async (): Promise<string> => {
      try {
        const tables = await listTables(db, schemas);
        if (tables.length === 0) return `No hay tablas en los esquemas: ${schemas.join(', ')}.`;

        const lines = tables.map(
          t =>
            `${t.schema}.${t.name} (${t.kind}) - ${t.columns} columnas, ~${t.approxRows.toLocaleString('es-ES')} filas, ${t.size}`,
        );
        return truncate(`${tables.length} tablas:\n${lines.join('\n')}`);
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

/** Tool 2: como es una tabla. */
export function makeDescribeTableTool(db: ReadOnlyDatabase, schemas: string[]): Tool {
  return tool(
    {
      name: 'describe_table',
      description:
        'Devuelve las columnas de una tabla con su tipo, si admite nulos, la clave primaria y las ' +
        'claves ajenas. Usala antes de escribir un SELECT sobre una tabla que no conozcas, para no ' +
        'inventarte nombres de columna.',
      inputs: {
        table: {
          type: 'string',
          description: 'Nombre de la tabla, con o sin esquema. Ejemplos: "order_book", "public.raw_trade".',
        },
      },
      outputType: 'string',
    },
    async ({ table }: { table: string }): Promise<string> => {
      try {
        const info = await describeTable(db, schemas, table);
        if (!info) {
          return `No existe ninguna tabla llamada "${table}" en los esquemas ${schemas.join(', ')}. Usa list_tables para ver las disponibles.`;
        }

        const lines = info.columns.map(col => {
          const flags = [
            col.isPrimaryKey ? 'PK' : null,
            col.nullable ? null : 'NOT NULL',
            col.references ? `-> ${col.references}` : null,
            col.default ? `default ${col.default}` : null,
          ].filter(Boolean);
          const suffix = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
          return `  ${col.name}: ${col.type}${suffix}`;
        });

        const needsQuotes = info.columns.filter(col => /[A-Z]/.test(col.name)).map(col => col.name);
        const warning =
          needsQuotes.length > 0
            ? `\n\nAtencion: estas columnas llevan mayusculas y en SQL hay que escribirlas entre comillas dobles: ${needsQuotes.map(n => `"${n}"`).join(', ')}.`
            : '';

        return truncate(`${info.schema}.${info.name}\n${lines.join('\n')}${warning}`);
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

/** Tool 3: ejecutar la consulta. */
export function makeRunQueryTool(db: ReadOnlyDatabase, maxRows: number): Tool {
  return tool(
    {
      name: 'run_query',
      description:
        'Ejecuta una consulta SQL de SOLO LECTURA contra Postgres y devuelve las filas en JSON. ' +
        'Solo se admite una sentencia y debe empezar por SELECT, WITH, EXPLAIN, SHOW, TABLE o VALUES; ' +
        'cualquier escritura sera rechazada. ' +
        `El resultado se limita a ${maxRows} filas, asi que agrega (COUNT, SUM, AVG, GROUP BY) en lugar de ` +
        'traerte tablas enteras. Los identificadores con mayusculas van entre comillas dobles.',
      inputs: {
        query: {
          type: 'string',
          description: 'La consulta SQL a ejecutar. Una sola sentencia, sin punto y coma final.',
        },
      },
      outputType: 'string',
    },
    async ({ query }: { query: string }): Promise<string> => {
      try {
        const result = await db.query(query, maxRows);
        if (result.rowCount === 0) return 'La consulta no ha devuelto ninguna fila.';

        const header = result.truncated
          ? `${result.rowCount} filas (recortado al limite de ${maxRows}; hay mas resultados):`
          : `${result.rowCount} fila${result.rowCount === 1 ? '' : 's'}:`;

        return truncate(`${header}\n${serializeRows(result.rows)}`);
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

/** Las tres tools de base de datos, listas para el agente. */
export function makePostgresTools(
  db: ReadOnlyDatabase,
  schemas: string[],
  maxRows: number,
): Tool[] {
  return [
    makeListTablesTool(db, schemas),
    makeDescribeTableTool(db, schemas),
    makeRunQueryTool(db, maxRows),
  ];
}
