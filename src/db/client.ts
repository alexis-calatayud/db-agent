import { SQL } from 'bun';
import type { DbConfig } from '../config/types';
import { applyRowLimit, assertReadOnly } from './guard';

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** true si se alcanzo el tope de filas y puede haber mas. */
  truncated: boolean;
}

/**
 * Acceso de solo lectura a Postgres.
 *
 * Cada consulta corre dentro de una transaccion `READ ONLY` con
 * `statement_timeout`: aunque el validador de `guard.ts` dejase pasar algo,
 * Postgres rechaza la escritura por su cuenta.
 */
export class ReadOnlyDatabase {
  private readonly sql: SQL;
  private readonly config: DbConfig;

  constructor(config: DbConfig) {
    this.config = config;
    this.sql = new SQL({
      url: config.url,
      max: 2,
      connectionTimeout: 10,
      // Nombre visible en pg_stat_activity: hace evidente de donde sale la query.
      connection: { application_name: 'agente-consola-ro' },
    });
  }

  /** Ejecuta SQL de lectura ya validado, con tope de filas. */
  async query(rawSql: string, maxRows = this.config.maxRows): Promise<QueryResult> {
    assertReadOnly(rawSql);
    const limit = Math.min(Math.max(1, maxRows), this.config.maxRows);
    const limited = applyRowLimit(rawSql, limit + 1);
    const rows = await this.runReadOnly(limited);

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return { rows: kept, rowCount: kept.length, truncated };
  }

  /**
   * Consulta interna de introspeccion. No pasa por el validador porque el SQL
   * lo escribimos nosotros, no el modelo, pero si por la transaccion READ ONLY.
   */
  async introspect(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    return this.runReadOnly(sql, params);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  private async runReadOnly(
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    return this.sql.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx.unsafe(`SET LOCAL statement_timeout = ${this.config.timeoutMs}`);
      const result = await tx.unsafe(sql, params as never[]);
      return result as unknown as Array<Record<string, unknown>>;
    }) as Promise<Array<Record<string, unknown>>>;
  }
}
