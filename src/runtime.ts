import type { OpenAIServerModel, Tool, ToolCallingAgent } from 'smolagents.js';
import { createAgent } from './agents/sql-agent';
import { loadConfig } from './config/env';
import type { AppConfig } from './config/types';
import { ReadOnlyDatabase } from './db/client';
import { listTables, summarizeSchema } from './db/introspect';
import { createEmbedder, type Embedder } from './memory/embeddings';
import { ReadOnlyMongo } from './mongo/client';
import { summarizeCollections } from './mongo/introspect';
import { backfillEmbeddings } from './memory/retrieval';
import { MemoryStore } from './memory/store';
import { createModel } from './model/factory';
import { makeMemoryTools } from './tools/memory';
import { makeMongoTools } from './tools/mongo';
import { makeNowTool } from './tools/now';
import { makePostgresTools } from './tools/postgres';
import { makeWebSearchTool } from './tools/web';
import { createSearcher } from './web/search';

/**
 * Todo lo que necesita el agente para funcionar, ya montado.
 *
 * Lo comparten la consola y el servidor web: si esto se construyera dos veces,
 * las dos interfaces acabarian comportandose distinto.
 */
export interface Runtime {
  config: AppConfig;
  model: OpenAIServerModel;
  store: MemoryStore;
  embedder?: Embedder | undefined;
  tools: Tool[];
  /** Catalogos de las bases que respondieron al arrancar. */
  schemaSummary?: string | undefined;
  /** Crea un agente nuevo con su propia memoria de conversacion. */
  newAgent(): ToolCallingAgent;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /** Donde van los avisos de arranque. Por defecto, a stderr. */
  notify?: (message: string) => void;
}

/**
 * Monta el agente: configuracion, modelo, memoria, tools y catalogo de tablas.
 *
 * Nada de esto aborta el arranque salvo un error de configuracion: si un
 * servicio externo no responde, se avisa y se sigue sin sus tools.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const notify = options.notify ?? ((message: string) => process.stderr.write(`${message}\n`));

  const config = loadConfig();
  const model = createModel(config);

  const store = new MemoryStore(config.memory.dbPath);
  // El aviso sale una sola vez, cuando se descubre que el proveedor no da
  // embeddings: a partir de ahi la memoria busca solo por texto.
  const embedder = createEmbedder(config, reason =>
    notify(`Busqueda semantica desactivada (${reason}). La memoria seguira funcionando con FTS5.`),
  );

  // `now` y la memoria no dependen de nada externo, asi que estan siempre. Las
  // de Postgres solo si hay DATABASE_URL configurada.
  const tools: Tool[] = [makeNowTool(), ...makeMemoryTools(store, embedder)];

  // La busqueda web se apoya en un modelo con busqueda integrada. Si el
  // proveedor no lo tiene, la tool lo dira en su primera llamada.
  const searcher = createSearcher(config, reason =>
    notify(`Busqueda en internet desactivada (${reason}).`),
  );
  if (searcher) tools.push(makeWebSearchTool(searcher));

  // El catalogo de tablas se lee una sola vez y viaja en el prompt de sistema.
  //
  // Si la base no responde, se sigue adelante sin sus tools: el resto no
  // depende de ella, y una caida de red no deberia dejar el agente inservible.
  const catalogs: string[] = [];
  let db: ReadOnlyDatabase | undefined;
  if (config.db) {
    const candidate = new ReadOnlyDatabase(config.db);
    try {
      catalogs.push(summarizeSchema(await listTables(candidate, config.db.schemas)));
      tools.push(...makePostgresTools(candidate, config.db.schemas, config.db.maxRows));
      db = candidate;
    } catch (error) {
      notify(
        `Base de datos no disponible (${error instanceof Error ? error.message : String(error)}). ` +
          'Arrancando sin las herramientas de Postgres.',
      );
      await candidate.close().catch(() => undefined);
    }
  }

  // MongoDB, con el mismo criterio: si no responde, se sigue sin sus tools.
  let mongo: ReadOnlyMongo | undefined;
  if (config.mongo) {
    const candidate = new ReadOnlyMongo(config.mongo);
    try {
      const collections = await candidate.listCollections();
      catalogs.push(summarizeCollections(config.mongo.database, collections));
      tools.push(
        ...makeMongoTools(candidate, config.mongo.maxDocuments, config.mongo.sampleSize),
      );
      mongo = candidate;
    } catch (error) {
      notify(
        `MongoDB no disponible (${error instanceof Error ? error.message : String(error)}). ` +
          'Arrancando sin sus herramientas.',
      );
      await candidate.close().catch(() => undefined);
    }
  }

  // Vectoriza lo que falte: memorias guardadas sin proveedor, o con un modelo
  // de embeddings distinto al actual.
  await backfillEmbeddings(store, embedder);

  const schemaSummary = catalogs.length > 0 ? catalogs.join('\n\n') : undefined;

  return {
    config,
    model,
    store,
    embedder,
    tools,
    schemaSummary,
    // Un agente por conversacion: la memoria de dialogo vive dentro del agente,
    // asi que dos sesiones web no pueden compartirlo sin pisarse.
    newAgent: () =>
      createAgent(config, model, tools, { schemaSummary, pinned: store.listPinned() }),
    async close() {
      store.close();
      await db?.close();
      await mongo?.close();
    },
  };
}
