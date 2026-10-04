import { ConfigError } from '../utils/errors';
import {
  LOG_LEVELS,
  type AppConfig,
  type DbConfig,
  type LogLevel,
  type MemoryConfig,
  type MongoConfig,
  type WebConfig,
} from './types';

/**
 * Valores por defecto. Apuntan a OpenAI: es el unico proveedor probado que
 * cubre las tres cosas que el agente necesita —tool calling nativo fiable,
 * embeddings para la memoria y busqueda web— con una sola API key.
 *
 * El proyecto sigue siendo compatible con cualquier endpoint OpenAI-compatible
 * (Groq, OpenRouter, Cerebras): basta cambiar LLM_BASE_URL y LLM_MODEL. Ojo con
 * lo que pierdes en cada uno; ver el README.
 */
export const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  // Elegido por fiabilidad en tool calling nativo, que es lo que necesita el
  // agente.
  model: 'gpt-5.5',
  temperature: 0.7,
  // Ojo al bajarlo: los planes gratuitos cuentan max_tokens como tokens
  // "solicitados" para el limite por minuto, pero por debajo de 2048 los
  // modelos que razonan antes de responder se quedan sin presupuesto y
  // devuelven una generacion vacia.
  maxTokens: 2048,
  requestsPerMinute: 25,
  logLevel: 'info' as LogLevel,
  systemPrompt:
    'Eres un asistente conciso y preciso. Respondes en el idioma en el que te ' +
    'pregunten. Si no sabes algo, lo dices en lugar de inventarlo. Si te preguntan fecha y hora respondes con formato largo y la zona hoaria CEST',
  maxSteps: 8,
  memoryDbPath: '.memory.db',
  embeddingsModel: 'text-embedding-3-small',
  autoRecall: 4,
  webSearchModel: 'gpt-4o-mini-search-preview',
  dbSchemas: 'public',
  dbMaxRows: 100,
  dbTimeoutMs: 15_000,
  mongoMaxDocuments: 50,
  mongoSampleSize: 100,
  mongoTimeoutMs: 15_000,
} as const;

type Env = Record<string, string | undefined>;

function readString(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function readNumber(
  env: Env,
  key: string,
  fallback: number,
  { min, max, integer = false }: { min: number; max: number; integer?: boolean },
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${key} debe ser un numero, pero vale "${raw}".`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`${key} debe ser un numero entero, pero vale "${raw}".`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} debe estar entre ${min} y ${max}, pero vale ${value}.`);
  }
  return value;
}

function readLogLevel(env: Env): LogLevel {
  const raw = env['LOG_LEVEL']?.trim().toLowerCase();
  if (!raw) return DEFAULTS.logLevel;
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new ConfigError(`LOG_LEVEL debe ser uno de: ${LOG_LEVELS.join(', ')}. Recibido: "${raw}".`);
  }
  return raw as LogLevel;
}

function readBaseUrl(env: Env): string {
  const value = readString(env, 'LLM_BASE_URL', DEFAULTS.baseUrl);
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new ConfigError(`LLM_BASE_URL no es una URL valida: "${value}".`);
  }
  return value;
}

/**
 * Configuracion de base de datos. Es opcional: sin `DATABASE_URL` la
 * aplicacion arranca igual, solo que sin tools de consulta.
 */
function readDbConfig(env: Env): DbConfig | undefined {
  const url = env['DATABASE_URL']?.trim();
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`DATABASE_URL no es una URL valida: "${url}".`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new ConfigError(
      `DATABASE_URL debe ser una URL postgres:// (recibido "${parsed.protocol}//").`,
    );
  }

  const schemas = readString(env, 'DB_SCHEMAS', DEFAULTS.dbSchemas)
    .split(',')
    .map(schema => schema.trim())
    .filter(Boolean);

  if (schemas.length === 0) {
    throw new ConfigError('DB_SCHEMAS no puede quedar vacio.');
  }

  return {
    url,
    schemas,
    maxRows: readNumber(env, 'DB_MAX_ROWS', DEFAULTS.dbMaxRows, {
      min: 1,
      max: 1000,
      integer: true,
    }),
    timeoutMs: readNumber(env, 'DB_TIMEOUT_MS', DEFAULTS.dbTimeoutMs, {
      min: 100,
      max: 300_000,
      integer: true,
    }),
  };
}

/**
 * MongoDB de solo lectura. La base va dentro de la URL a proposito: asi el
 * agente queda acotado a una sola y no puede saltar a otra del mismo servidor.
 */
function readMongoConfig(env: Env): MongoConfig | undefined {
  const url = env['MONGODB_URL']?.trim();
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`MONGODB_URL no es una URL valida: "${url}".`);
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new ConfigError(
      `MONGODB_URL debe ser una URL mongodb:// (recibido "${parsed.protocol}//").`,
    );
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).trim();
  if (!database) {
    throw new ConfigError(
      'MONGODB_URL debe incluir la base de datos al final, por ejemplo ' +
        'mongodb://servidor:27017/mi_base. Sin ella el agente no sabria a cual conectarse.',
    );
  }

  return {
    url,
    database,
    maxDocuments: readNumber(env, 'MONGO_MAX_DOCS', DEFAULTS.mongoMaxDocuments, {
      min: 1,
      max: 500,
      integer: true,
    }),
    sampleSize: readNumber(env, 'MONGO_SAMPLE_SIZE', DEFAULTS.mongoSampleSize, {
      min: 1,
      max: 1000,
      integer: true,
    }),
    timeoutMs: readNumber(env, 'MONGO_TIMEOUT_MS', DEFAULTS.mongoTimeoutMs, {
      min: 100,
      max: 300_000,
      integer: true,
    }),
  };
}

/**
 * Memoria persistente. Siempre presente: a diferencia de la base de datos, no
 * depende de ningun servicio externo.
 */
function readMemoryConfig(env: Env, baseUrl: string): MemoryConfig {
  return {
    dbPath: readString(env, 'MEMORY_DB_PATH', DEFAULTS.memoryDbPath),
    // Vacio a proposito significa "sin embeddings": se busca solo por texto.
    embeddingsModel: env['EMBEDDINGS_MODEL']?.trim() ?? DEFAULTS.embeddingsModel,
    embeddingsBaseUrl: readString(env, 'EMBEDDINGS_BASE_URL', baseUrl),
    autoRecall: readNumber(env, 'MEMORY_AUTO_RECALL', DEFAULTS.autoRecall, {
      min: 0,
      max: 50,
      integer: true,
    }),
  };
}

/**
 * Busqueda en internet. Se apoya en un modelo con busqueda integrada, asi que
 * no hace falta dar de alta ningun servicio aparte.
 */
function readWebConfig(env: Env, baseUrl: string): WebConfig {
  return {
    // Vacio a proposito significa "sin tool de busqueda".
    searchModel: env['WEB_SEARCH_MODEL']?.trim() ?? DEFAULTS.webSearchModel,
    baseUrl: readString(env, 'WEB_SEARCH_BASE_URL', baseUrl),
  };
}

/**
 * Lee y valida la configuracion. Se llama una sola vez, al arrancar.
 *
 * Recibe el entorno como parametro para poder testearla sin tocar process.env.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const apiKey = env['LLM_API_KEY']?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'Falta LLM_API_KEY.\n\n' +
        '  1. Copia .env.example a .env\n' +
        '  2. Consigue una API key en https://platform.openai.com/api-keys\n' +
        '  3. Pegala en LLM_API_KEY',
    );
  }

  const db = readDbConfig(env);
  const mongo = readMongoConfig(env);
  const baseUrl = readBaseUrl(env);

  return {
    apiKey,
    baseUrl,
    model: readString(env, 'LLM_MODEL', DEFAULTS.model),
    temperature: readNumber(env, 'LLM_TEMPERATURE', DEFAULTS.temperature, { min: 0, max: 2 }),
    maxTokens: readNumber(env, 'LLM_MAX_TOKENS', DEFAULTS.maxTokens, {
      min: 1,
      max: 1_000_000,
      integer: true,
    }),
    requestsPerMinute: readNumber(env, 'LLM_REQUESTS_PER_MINUTE', DEFAULTS.requestsPerMinute, {
      min: 1,
      max: 10_000,
      integer: true,
    }),
    systemPrompt: readString(env, 'SYSTEM_PROMPT', DEFAULTS.systemPrompt),
    logLevel: readLogLevel(env),
    maxSteps: readNumber(env, 'AGENT_MAX_STEPS', DEFAULTS.maxSteps, {
      min: 1,
      max: 50,
      integer: true,
    }),
    memory: readMemoryConfig(env, baseUrl),
    web: readWebConfig(env, baseUrl),
    ...(db ? { db } : {}),
    ...(mongo ? { mongo } : {}),
  };
}
