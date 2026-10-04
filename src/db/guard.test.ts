import { describe, expect, it } from 'bun:test';
import { UnsafeQueryError, applyRowLimit, assertReadOnly, maskLiterals } from './guard';

const rejects = (sql: string) => expect(() => assertReadOnly(sql)).toThrow(UnsafeQueryError);
const accepts = (sql: string) => expect(() => assertReadOnly(sql)).not.toThrow();

describe('maskLiterals', () => {
  it('conserva la longitud del original', () => {
    const sql = "select 'hola' /* nota */ from t -- fin";
    expect(maskLiterals(sql)).toHaveLength(sql.length);
  });

  it('neutraliza cadenas, comentarios e identificadores entrecomillados', () => {
    const masked = maskLiterals(`select "dateUp" from t where x = 'drop table y' -- delete`);
    expect(masked).not.toContain('drop');
    expect(masked).not.toContain('delete');
    expect(masked).not.toContain('dateUp');
    expect(masked).toContain('select');
  });

  it('entiende comillas simples escapadas al estilo SQL', () => {
    const masked = maskLiterals("select 'it''s a drop' as x");
    expect(masked).not.toContain('drop');
    expect(masked).toContain('as x');
  });

  it('entiende comentarios de bloque anidados y cadenas con dolar', () => {
    expect(maskLiterals('select 1 /* a /* b */ c */ , 2')).not.toContain('a');
    expect(maskLiterals('select $$ drop table x $$')).not.toContain('drop');
  });

  it('rechaza literales sin cerrar en lugar de adivinar', () => {
    expect(() => maskLiterals("select 'sin cerrar")).toThrow(UnsafeQueryError);
    expect(() => maskLiterals('select /* sin cerrar')).toThrow(UnsafeQueryError);
  });
});

describe('assertReadOnly: acepta lectura legitima', () => {
  it('acepta las formas de consulta habituales', () => {
    accepts('SELECT 1');
    accepts('select * from public.venue');
    accepts('WITH t AS (SELECT 1 AS n) SELECT n FROM t');
    accepts('EXPLAIN SELECT * FROM order_book');
    accepts('SHOW server_version');
    accepts('VALUES (1), (2)');
    accepts('select count(*) from raw_trade');
  });

  it('acepta un punto y coma final suelto', () => {
    accepts('SELECT 1;');
    accepts('SELECT 1;   \n');
  });

  it('no confunde datos con palabras clave', () => {
    accepts("select * from t where accion = 'delete'");
    accepts('select "update" from t');
    accepts('select 1 -- drop table x');
  });

  it('no se dispara con palabras que contienen otra prohibida', () => {
    accepts('select x from t offset 10');
    accepts('select * from settings');
    accepts('select insert_date from audit_log');
    accepts('select * from pg_stat_activity');
  });
});

describe('assertReadOnly: rechaza escritura', () => {
  it('rechaza DML y DDL directos', () => {
    rejects('DELETE FROM venue');
    rejects('insert into venue values (1)');
    rejects('UPDATE venue SET name = 1');
    rejects('DROP TABLE venue');
    rejects('TRUNCATE venue');
    rejects('CREATE TABLE x (i int)');
    rejects('ALTER TABLE venue ADD COLUMN x int');
    rejects('GRANT ALL ON venue TO public');
  });

  it('rechaza encadenar sentencias', () => {
    rejects('SELECT 1; DROP TABLE venue');
    rejects('SELECT 1; SELECT 2');
    rejects("SELECT 'a'; DELETE FROM venue");
  });

  it('rechaza CTE que escriben', () => {
    rejects('WITH x AS (DELETE FROM venue RETURNING *) SELECT * FROM x');
    rejects('WITH x AS (INSERT INTO venue VALUES (1) RETURNING *) SELECT * FROM x');
  });

  it('rechaza SELECT INTO, que crea una tabla', () => {
    rejects('SELECT * INTO nueva FROM venue');
  });

  it('rechaza EXPLAIN ANALYZE, que ejecuta de verdad', () => {
    rejects('EXPLAIN ANALYZE SELECT * FROM order_book');
  });

  it('rechaza cambiar parametros de sesion y control de transaccion', () => {
    rejects('SET statement_timeout = 0');
    rejects('BEGIN');
    rejects('COMMIT');
    rejects('DISCARD ALL');
  });

  it('rechaza funciones que tocan el sistema de ficheros o el servidor', () => {
    rejects("SELECT pg_read_file('/etc/passwd')");
    rejects("SELECT lo_import('/etc/passwd')");
    rejects('SELECT pg_sleep(60)');
    rejects('SELECT pg_terminate_backend(1)');
  });

  it('rechaza procedimientos y ejecucion diferida', () => {
    rejects('CALL algun_procedimiento()');
    rejects("DO $$ BEGIN PERFORM 1; END $$");
    rejects('EXECUTE plan_preparado');
  });

  it('no se deja enganar por comentarios ni mayusculas raras', () => {
    rejects('/* comentario */ DELETE FROM venue');
    rejects('DeLeTe FROM venue');
    rejects('\n\n  drop table venue');
  });

  it('rechaza la consulta vacia', () => {
    rejects('');
    rejects('   \n  ');
  });
});

describe('applyRowLimit', () => {
  it('envuelve la consulta para que el LIMIT no dependa del modelo', () => {
    const limited = applyRowLimit('SELECT * FROM order_book', 50);
    expect(limited).toContain('LIMIT 50');
    expect(limited).toContain('_agent_query');
  });

  it('acota tambien las consultas que ya traen su propio LIMIT', () => {
    const limited = applyRowLimit('SELECT * FROM order_book LIMIT 999999', 50);
    expect(limited.trimEnd().endsWith('LIMIT 50')).toBe(true);
  });

  it('deja intactos EXPLAIN y SHOW, que no se pueden envolver', () => {
    expect(applyRowLimit('EXPLAIN SELECT 1', 50)).toBe('EXPLAIN SELECT 1');
    expect(applyRowLimit('SHOW server_version', 50)).toBe('SHOW server_version');
  });

  it('quita el punto y coma final antes de envolver', () => {
    expect(applyRowLimit('SELECT 1;', 10)).not.toContain(';');
  });
});
