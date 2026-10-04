import { describe, expect, it } from 'bun:test';
import type { ReadOnlyDatabase } from '../db/client';
import { UnsafeQueryError } from '../db/guard';
import { makeDescribeTableTool, makeListTablesTool, makeRunQueryTool } from './postgres';

/** Doble de la base de datos: las tools no deben saber que no es real. */
function fakeDb(overrides: Partial<ReadOnlyDatabase> = {}): ReadOnlyDatabase {
  return {
    query: async () => ({ rows: [], rowCount: 0, truncated: false }),
    introspect: async () => [],
    close: async () => undefined,
    ...overrides,
  } as unknown as ReadOnlyDatabase;
}

describe('run_query', () => {
  it('devuelve las filas en JSON con el numero de filas por delante', async () => {
    const db = fakeDb({
      query: async () => ({ rows: [{ n: 6 }, { n: 7 }], rowCount: 2, truncated: false }),
    });
    const output = await makeRunQueryTool(db, 100).call({ query: 'select n from t' });

    expect(output).toContain('2 filas');
    expect(output).toContain('[{"n":6},{"n":7}]');
  });

  it('avisa cuando el resultado se ha recortado, para que el modelo agregue', async () => {
    const db = fakeDb({
      query: async () => ({ rows: [{ n: 1 }], rowCount: 1, truncated: true }),
    });
    const output = await makeRunQueryTool(db, 100).call({ query: 'select n from t' });

    expect(output).toContain('recortado');
    expect(output).toContain('hay mas resultados');
  });

  it('serializa BigInt, fechas y bytea sin romperse', async () => {
    const db = fakeDb({
      query: async () => ({
        rows: [
          {
            total: 3_725_499n,
            cuando: new Date('2026-07-27T10:00:00Z'),
            blob: new Uint8Array([1, 2, 3]),
            vacio: null,
          },
        ],
        rowCount: 1,
        truncated: false,
      }),
    });
    const output = await makeRunQueryTool(db, 100).call({ query: 'select 1' });

    expect(output).toContain('"total":"3725499"');
    expect(output).toContain('2026-07-27T10:00:00.000Z');
    expect(output).toContain('<3 bytes>');
    expect(output).toContain('"vacio":null');
  });

  it('convierte el rechazo de seguridad en algo que el modelo puede corregir', async () => {
    const db = fakeDb({
      query: async () => {
        throw new UnsafeQueryError('Solo se permite una sentencia por llamada.');
      },
    });
    const output = await makeRunQueryTool(db, 100).call({ query: 'select 1; drop table t' });

    expect(output).toStartWith('Consulta rechazada:');
    expect(output).toContain('una sentencia');
  });

  it('devuelve el error de Postgres en vez de propagarlo y matar el turno', async () => {
    const db = fakeDb({
      query: async () => {
        throw new Error('column "inventada" does not exist');
      },
    });
    const output = await makeRunQueryTool(db, 100).call({ query: 'select inventada from t' });

    expect(output).toContain('column "inventada" does not exist');
  });

  it('avisa cuando no hay filas, sin devolver un JSON vacio ambiguo', async () => {
    const output = await makeRunQueryTool(fakeDb(), 100).call({ query: 'select 1 where false' });
    expect(output).toContain('no ha devuelto ninguna fila');
  });
});

describe('describe_table', () => {
  const columnRows = [
    { name: 'id', type: 'uuid', nullable: false, default_value: null, is_pk: true, references: null },
    { name: 'dateUp', type: 'timestamp', nullable: true, default_value: null, is_pk: false, references: null },
  ];

  it('marca las columnas con mayusculas, que en SQL necesitan comillas dobles', async () => {
    let call = 0;
    const db = fakeDb({
      introspect: async () => (call++ === 0 ? [{ schema: 'public', name: 'order_book' }] : columnRows),
    });
    const output = await makeDescribeTableTool(db, ['public']).call({ table: 'order_book' });

    expect(output).toContain('public.order_book');
    expect(output).toContain('id: uuid');
    expect(output).toContain('PK');
    expect(output).toContain('"dateUp"');
    expect(output).toContain('comillas dobles');
  });

  it('redirige a list_tables cuando la tabla no existe', async () => {
    const output = await makeDescribeTableTool(fakeDb(), ['public']).call({ table: 'fantasma' });
    expect(output).toContain('No existe');
    expect(output).toContain('list_tables');
  });
});

describe('list_tables', () => {
  it('resume cada tabla en una linea', async () => {
    const db = fakeDb({
      introspect: async () => [
        { schema: 'public', name: 'venue', kind: 'table', columns: 4, approx_rows: 6, size: '48 kB' },
      ],
    });
    const output = await makeListTablesTool(db, ['public']).call({});

    expect(output).toContain('1 tablas');
    expect(output).toContain('public.venue (table) - 4 columnas, ~6 filas, 48 kB');
  });

  it('lo dice claramente si no hay ninguna tabla visible', async () => {
    const output = await makeListTablesTool(fakeDb(), ['public']).call({});
    expect(output).toContain('No hay tablas');
  });
});
