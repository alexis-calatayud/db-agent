import { MongoClient, type Db } from 'mongodb';
import type { MongoConfig } from '../config/types';
import { assertReadOnlyFilter, assertReadOnlyPipeline } from './guard';

export interface FindOptions {
  filter?: unknown;
  projection?: unknown;
  sort?: unknown;
  limit?: number;
  skip?: number;
}

export interface DocumentsResult {
  documents: Array<Record<string, unknown>>;
  /** true si se alcanzo el tope y puede haber mas. */
  truncated: boolean;
}

export interface CollectionSummary {
  name: string;
  documents: number;
}

/**
 * Acceso de solo lectura a una unica base de MongoDB.
 *
 * La clase no expone —ni usa internamente— ninguna operacion de escritura del
 * driver: no hay insert, update, delete ni drop en ninguna ruta de codigo. Esa
 * es la segunda barrera, y es mas debil que la de Postgres, donde era el propio
 * servidor quien rechazaba escribir dentro de una transaccion READ ONLY.
 *
 * La base va fija en la URL: el agente no puede saltar a otra, y `listDatabases`
 * no se expone en ningun sitio.
 */
export class ReadOnlyMongo {
  private readonly client: MongoClient;
  private readonly config: MongoConfig;
  private db: Db | null = null;

  constructor(config: MongoConfig) {
    this.config = config;
    this.client = new MongoClient(config.url, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
      serverSelectionTimeoutMS: config.timeoutMs,
      connectTimeoutMS: config.timeoutMs,
      // Visible en db.currentOp(): deja claro de donde sale cada consulta.
      appname: 'agente-consola-ro',
    } as ConstructorParameters<typeof MongoClient>[1]);
  }

  private async database(): Promise<Db> {
    if (!this.db) {
      await this.client.connect();
      // Sin argumento toma la base de la URL, que es justo lo que queremos.
      this.db = this.client.db();
    }
    return this.db;
  }

  get databaseName(): string {
    return this.config.database;
  }

  async listCollections(): Promise<CollectionSummary[]> {
    const db = await this.database();
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();

    const summaries = await Promise.all(
      collections
        .filter(collection => !collection.name.startsWith('system.'))
        .map(async collection => ({
          name: collection.name,
          documents: await db.collection(collection.name).estimatedDocumentCount(),
        })),
    );

    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Muestra aleatoria, para inferir la forma de los documentos. */
  async sample(collection: string, size: number): Promise<Array<Record<string, unknown>>> {
    const db = await this.database();
    return db
      .collection(collection)
      .aggregate([{ $sample: { size } }], { maxTimeMS: this.config.timeoutMs })
      .toArray();
  }

  async find(collection: string, options: FindOptions = {}): Promise<DocumentsResult> {
    const filter = options.filter ?? {};
    assertReadOnlyFilter(filter);
    if (options.projection !== undefined) assertReadOnlyFilter(options.projection);
    if (options.sort !== undefined) assertReadOnlyFilter(options.sort);

    const limit = this.cappedLimit(options.limit);
    const db = await this.database();

    // Se pide una de mas para saber si habia mas resultados.
    const cursor = db
      .collection(collection)
      .find(filter as Record<string, unknown>, { maxTimeMS: this.config.timeoutMs })
      .limit(limit + 1);

    if (options.projection) cursor.project(options.projection as Record<string, unknown>);
    if (options.sort) cursor.sort(options.sort as Record<string, 1 | -1>);
    if (options.skip) cursor.skip(Math.max(0, Math.trunc(options.skip)));

    const documents = await cursor.toArray();
    return this.trim(documents, limit);
  }

  async aggregate(collection: string, pipeline: unknown, limit?: number): Promise<DocumentsResult> {
    assertReadOnlyPipeline(pipeline);

    const capped = this.cappedLimit(limit);
    const db = await this.database();

    // El $limit se anyade al final para que el tope no dependa de que el modelo
    // se acuerde de ponerlo, igual que el LIMIT envolvente en Postgres.
    const documents = await db
      .collection(collection)
      .aggregate([...pipeline, { $limit: capped + 1 }], { maxTimeMS: this.config.timeoutMs })
      .toArray();

    return this.trim(documents, capped);
  }

  async countDocuments(collection: string, filter: unknown = {}): Promise<number> {
    assertReadOnlyFilter(filter);
    const db = await this.database();
    return db
      .collection(collection)
      .countDocuments(filter as Record<string, unknown>, { maxTimeMS: this.config.timeoutMs });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private cappedLimit(requested?: number): number {
    const value = requested ?? this.config.maxDocuments;
    return Math.min(Math.max(1, Math.trunc(value)), this.config.maxDocuments);
  }

  private trim(documents: Array<Record<string, unknown>>, limit: number): DocumentsResult {
    const truncated = documents.length > limit;
    return { documents: truncated ? documents.slice(0, limit) : documents, truncated };
  }
}
