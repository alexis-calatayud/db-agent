/**
 * Barrera de solo-lectura para el SQL que escribe el modelo.
 *
 * Es la primera de dos defensas. La segunda es la transaccion `READ ONLY` de
 * Postgres (ver `client.ts`), que bloquea cualquier escritura aunque este
 * validador fallase. Este modulo existe para que el modelo reciba un error
 * claro y para cerrar vias que la transaccion no cubre: encadenar sentencias,
 * cambiar parametros de sesion o leer ficheros del servidor.
 */

export class UnsafeQueryError extends Error {
  override readonly name = 'UnsafeQueryError';
}

/** Sentencias con las que puede empezar una consulta de lectura. */
const ALLOWED_STARTS = ['select', 'with', 'explain', 'show', 'table', 'values'] as const;

/**
 * Palabras prohibidas en cualquier posicion. `ANALYZE` entra porque
 * `EXPLAIN ANALYZE` ejecuta la consulta de verdad, e `INTO` porque
 * `SELECT ... INTO` crea una tabla.
 */
const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'create', 'alter',
  'grant', 'revoke', 'comment', 'copy', 'vacuum', 'analyze', 'reindex', 'cluster',
  'lock', 'set', 'reset', 'begin', 'start', 'commit', 'rollback', 'savepoint',
  'call', 'do', 'execute', 'prepare', 'deallocate', 'discard', 'listen', 'notify',
  'unlisten', 'refresh', 'import', 'into', 'setval', 'nextval',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export', 'dblink', 'pg_sleep', 'pg_terminate_backend',
  'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
];

const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');

/**
 * Sustituye el contenido de comentarios, cadenas e identificadores
 * entrecomillados por caracteres neutros, conservando la longitud.
 *
 * Asi las comprobaciones de palabras clave no se disparan con datos
 * (`WHERE nombre = 'delete'`) ni se dejan enganar por ellos
 * (`SELECT 1 /* ; drop table x *\/`).
 */
export function maskLiterals(sql: string): string {
  const out = [...sql];
  let i = 0;

  const blank = (from: number, to: number, fill = ' ') => {
    for (let k = from; k < to && k < out.length; k++) out[k] = fill;
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      // Postgres permite comentarios de bloque anidados.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; continue; }
        if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) throw new UnsafeQueryError('La consulta tiene un comentario /* sin cerrar.');
      blank(i, j);
      i = j;
      continue;
    }

    const char = sql[i]!;

    if (char === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      if (j >= sql.length) throw new UnsafeQueryError('La consulta tiene una cadena sin cerrar.');
      blank(i + 1, j, 'x');
      i = j + 1;
      continue;
    }

    if (char === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') break;
        j++;
      }
      if (j >= sql.length) throw new UnsafeQueryError('La consulta tiene un identificador entrecomillado sin cerrar.');
      blank(i + 1, j, 'i');
      i = j + 1;
      continue;
    }

    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        if (end === -1) throw new UnsafeQueryError('La consulta tiene una cadena $$ sin cerrar.');
        blank(i, end + marker.length, 'x');
        i = end + marker.length;
        continue;
      }
    }

    i++;
  }

  return out.join('');
}

/** Quita punto y coma y espacios finales. */
function trimTrailing(sql: string): string {
  return sql.replace(/[\s;]+$/, '');
}

/**
 * Rechaza cualquier SQL que no sea una unica consulta de lectura.
 *
 * @throws {UnsafeQueryError} con un mensaje pensado para que el modelo pueda
 * corregirse solo en el siguiente paso.
 */
export function assertReadOnly(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw new UnsafeQueryError('La consulta esta vacia.');

  const masked = maskLiterals(trimmed);

  if (trimTrailing(masked).includes(';')) {
    throw new UnsafeQueryError(
      'Solo se permite una sentencia por llamada. Quita el ";" intermedio y envia una sola consulta.',
    );
  }

  const body = trimTrailing(masked);
  const firstWord = /^\s*([a-z_]+)/i.exec(body)?.[1]?.toLowerCase() ?? '';

  if (!(ALLOWED_STARTS as readonly string[]).includes(firstWord)) {
    throw new UnsafeQueryError(
      `Solo se permiten consultas de lectura (${ALLOWED_STARTS.join(', ').toUpperCase()}). ` +
        `Esta empieza por "${firstWord.toUpperCase() || '?'}".`,
    );
  }

  const forbidden = FORBIDDEN_RE.exec(body);
  if (forbidden) {
    throw new UnsafeQueryError(
      `La consulta contiene "${forbidden[1]!.toUpperCase()}", que no esta permitido en modo solo lectura.`,
    );
  }
}

/**
 * Envuelve la consulta en un subselect con LIMIT para que ninguna respuesta
 * pueda desbordar el contexto del modelo, aunque olvide el LIMIT.
 *
 * `EXPLAIN` y `SHOW` no se pueden envolver y devuelven pocas filas de por si,
 * asi que se dejan intactos.
 */
export function applyRowLimit(sql: string, maxRows: number): string {
  const body = trimTrailing(sql.trim());
  const firstWord = /^\s*([a-z_]+)/i.exec(maskLiterals(body))?.[1]?.toLowerCase() ?? '';

  if (firstWord === 'explain' || firstWord === 'show') return body;

  return `SELECT * FROM (\n${body}\n) AS _agent_query LIMIT ${maxRows}`;
}
