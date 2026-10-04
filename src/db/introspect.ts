import type { ReadOnlyDatabase } from './client';

export interface TableSummary {
  schema: string;
  name: string;
  kind: string;
  columns: number;
  approxRows: number;
  size: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  references: string | null;
}

/**
 * Lista las tablas y vistas de los esquemas configurados.
 *
 * Excluye los esquemas internos de TimescaleDB (`_timescaledb_*`), que en esta
 * base son mas de la mitad del catalogo y solo servirian para llenar el
 * contexto del modelo de ruido.
 */
export async function listTables(db: ReadOnlyDatabase, schemas: string[]): Promise<TableSummary[]> {
  const rows = await db.introspect(
    `SELECT n.nspname                                   AS schema,
            c.relname                                   AS name,
            CASE c.relkind WHEN 'r' THEN 'table'
                           WHEN 'p' THEN 'partitioned table'
                           WHEN 'v' THEN 'view'
                           WHEN 'm' THEN 'materialized view'
                           ELSE c.relkind::text END     AS kind,
            (SELECT count(*) FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
            GREATEST(c.reltuples, 0)::bigint            AS approx_rows,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY(string_to_array($1, ','))
        AND n.nspname NOT LIKE '\\_timescaledb%'
        AND c.relkind IN ('r', 'p', 'v', 'm')
      ORDER BY n.nspname, c.relname`,
    [schemas.join(',')],
  );

  return rows.map(row => ({
    schema: String(row['schema']),
    name: String(row['name']),
    kind: String(row['kind']),
    columns: Number(row['columns']),
    approxRows: Number(row['approx_rows']),
    size: String(row['size']),
  }));
}

/**
 * Catalogo compacto para meter en el prompt de sistema. Una linea por tabla:
 * lo justo para que el modelo sepa que existe sin gastar medio contexto.
 */
export function summarizeSchema(tables: TableSummary[]): string {
  if (tables.length === 0) return 'La base de datos no tiene tablas visibles.';

  const lines = tables.map(
    t => `- ${t.schema}.${t.name} (~${t.approxRows.toLocaleString('es-ES')} filas)`,
  );
  return `Catalogo de la base de datos (${tables.length} tablas). Estas son TODAS las que existen:\n${lines.join('\n')}`;
}

/** Columnas, clave primaria y claves ajenas de una tabla. */
export async function describeTable(
  db: ReadOnlyDatabase,
  schemas: string[],
  table: string,
): Promise<{ schema: string; name: string; columns: ColumnInfo[] } | null> {
  // El nombre puede venir como "esquema.tabla" o solo "tabla".
  const [maybeSchema, maybeName] = table.includes('.')
    ? (table.split('.', 2) as [string, string])
    : [null, table];

  const located = await db.introspect(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1
        AND n.nspname = ANY(string_to_array($2, ','))
        AND ($3::text IS NULL OR n.nspname = $3)
        AND c.relkind IN ('r', 'p', 'v', 'm')
      LIMIT 1`,
    [maybeName, schemas.join(','), maybeSchema],
  );

  const found = located[0];
  if (!found) return null;

  const schema = String(found['schema']);
  const name = String(found['name']);

  const rows = await db.introspect(
    `SELECT a.attname                                        AS name,
            format_type(a.atttypid, a.atttypmod)             AS type,
            NOT a.attnotnull                                 AS nullable,
            pg_get_expr(d.adbin, d.adrelid)                  AS default_value,
            COALESCE(pk.is_pk, false)                        AS is_pk,
            fk.ref                                           AS references
       FROM pg_attribute a
       JOIN pg_class c      ON c.oid = a.attrelid
       JOIN pg_namespace n  ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN LATERAL (
              SELECT true AS is_pk
                FROM pg_constraint pc
               WHERE pc.conrelid = c.oid AND pc.contype = 'p' AND a.attnum = ANY(pc.conkey)
               LIMIT 1) pk ON true
       LEFT JOIN LATERAL (
              SELECT fn.nspname || '.' || fc.relname AS ref
                FROM pg_constraint pc
                JOIN pg_class fc     ON fc.oid = pc.confrelid
                JOIN pg_namespace fn ON fn.oid = fc.relnamespace
               WHERE pc.conrelid = c.oid AND pc.contype = 'f' AND a.attnum = ANY(pc.conkey)
               LIMIT 1) fk ON true
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, name],
  );

  return {
    schema,
    name,
    columns: rows.map(row => ({
      name: String(row['name']),
      type: String(row['type']),
      nullable: Boolean(row['nullable']),
      default: row['default_value'] === null ? null : String(row['default_value']),
      isPrimaryKey: Boolean(row['is_pk']),
      references: row['references'] === null ? null : String(row['references']),
    })),
  };
}
