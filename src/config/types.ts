export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Conexion de solo lectura a Postgres. Ausente si no se configura DATABASE_URL. */
export interface DbConfig {
  url: string;
  /** Esquemas visibles para el agente. */
  schemas: string[];
  /** Tope de filas por consulta. */
  maxRows: number;
  /** statement_timeout de Postgres, en milisegundos. */
  timeoutMs: number;
}

/** Conexion de solo lectura a MongoDB. Ausente si no se configura MONGODB_URL. */
export interface MongoConfig {
  url: string;
  /** Base a la que se acota el agente. Sale de la propia URL. */
  database: string;
  /** Tope de documentos por consulta. */
  maxDocuments: number;
  /** Documentos que se muestrean para inferir el esquema. */
  sampleSize: number;
  /** maxTimeMS de las operaciones, en milisegundos. */
  timeoutMs: number;
}

/** Memoria persistente del agente. Siempre activa: no depende de nada externo. */
export interface MemoryConfig {
  /** Fichero SQLite donde vive todo. */
  dbPath: string;
  /** Modelo de embeddings. Cadena vacia = solo busqueda por texto (FTS5). */
  embeddingsModel: string;
  /** Endpoint de embeddings. Por defecto, el mismo que el del chat. */
  embeddingsBaseUrl: string;
  /** Memorias relevantes que se inyectan en cada pregunta. 0 lo desactiva. */
  autoRecall: number;
}

/** Busqueda en internet. */
export interface WebConfig {
  /** Modelo con busqueda web integrada. Cadena vacia = sin tool de busqueda. */
  searchModel: string;
  /** Endpoint. Por defecto, el mismo que el del chat. */
  baseUrl: string;
}

/**
 * Configuracion efectiva de la aplicacion, ya validada.
 *
 * Todo lo que depende del proveedor LLM vive aqui: cambiar de Groq a
 * OpenRouter o Cerebras debe ser editar el `.env`, nunca tocar codigo.
 */
export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestsPerMinute: number;
  systemPrompt: string;
  logLevel: LogLevel;
  /** Sin esto la aplicacion arranca igual, pero sin tools de base de datos. */
  db?: DbConfig;
  /** Sin esto la aplicacion arranca igual, pero sin tools de MongoDB. */
  mongo?: MongoConfig;
  memory: MemoryConfig;
  web: WebConfig;
  /** Tope de iteraciones del agente por pregunta. */
  maxSteps: number;
}
