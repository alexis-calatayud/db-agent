/**
 * Error de configuracion: se detecta al arrancar y termina el proceso con
 * codigo 1, sin stack trace.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Error de una llamada al modelo, ya traducido a algo que un humano entiende. */
export interface FriendlyError {
  /** Titulo corto de la linea de error. */
  message: string;
  /** Que puede hacer el usuario al respecto. */
  hint?: string;
  /** Si reintentar el mismo turno tiene sentido. */
  retriable: boolean;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status;

  // Los errores del agente envuelven el original y pierden `.status`, pero
  // conservan el codigo dentro del texto ("... 400 Failed to call a function").
  const message = error instanceof Error ? error.message : '';
  const embedded = /\b(4\d{2}|5\d{2})\b/.exec(message);
  return embedded ? Number(embedded[1]) : undefined;
}

/** Nombres de error de smolagents que indican fallo del bucle, no de la API. */
const AGENT_ERROR_NAMES = new Set([
  'AgentError',
  'AgentParsingError',
  'AgentExecutionError',
  'AgentMaxStepsError',
  'AgentToolCallError',
  'AgentToolExecutionError',
  'AgentGenerationError',
]);

function isAgentError(error: unknown): error is Error {
  return error instanceof Error && AGENT_ERROR_NAMES.has(error.constructor.name);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Traduce un error de la API a un mensaje accionable. Nunca lanza: la REPL
 * debe sobrevivir a cualquier fallo de red o de proveedor.
 */
export function describeError(error: unknown, model: string): FriendlyError {
  const status = statusOf(error);
  const raw = messageOf(error);

  if (error instanceof Error && error.constructor.name === 'AgentMaxStepsError') {
    return {
      message: 'El agente ha agotado sus pasos sin llegar a una respuesta.',
      hint: 'Concreta mas la pregunta, o sube AGENT_MAX_STEPS en el .env.',
      retriable: true,
    };
  }

  // Groq responde 400 cuando el modelo genera una llamada a tool mal formada.
  if (status === 400) {
    return {
      message: `El modelo "${model}" no ha conseguido generar una llamada valida a las herramientas.`,
      hint: 'Reformula la pregunta, o cambia LLM_MODEL por uno mas solido en tool calling (por ejemplo openai/gpt-oss-120b).',
      retriable: true,
    };
  }

  if (isAgentError(error) && status === undefined) {
    return {
      message: 'El agente no ha podido completar el ciclo.',
      hint: raw.split('\n')[0] ?? raw,
      retriable: true,
    };
  }

  if (status === 401 || status === 403) {
    return {
      message: 'API key invalida o sin permisos.',
      hint: 'Revisa LLM_API_KEY en tu .env y que la key siga activa en el proveedor.',
      retriable: false,
    };
  }

  if (status === 404) {
    return {
      message: `El proveedor no reconoce el modelo "${model}".`,
      hint: 'Revisa LLM_MODEL. Puede que el modelo se haya retirado del catalogo.',
      retriable: false,
    };
  }

  if (status === 429) {
    const seconds = retryAfterSeconds(raw);
    return {
      message: 'Limite de peticiones alcanzado (rate limit).',
      hint: seconds
        ? `Espera ~${seconds}s antes de reintentar.`
        : 'En el plan gratuito el limite que salta antes es el de tokens por minuto. ' +
          'Espera un minuto, o baja LLM_MAX_TOKENS.',
      retriable: true,
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      message: `El proveedor devolvio un error ${status}.`,
      hint: 'Es transitorio. Vuelve a lanzar la misma pregunta.',
      retriable: true,
    };
  }

  if (status === undefined) {
    return {
      message: 'No se ha podido contactar con el proveedor.',
      hint: `Revisa tu conexion y LLM_BASE_URL. Detalle: ${raw}`,
      retriable: true,
    };
  }

  return {
    message: `Error ${status} del proveedor.`,
    hint: raw,
    retriable: false,
  };
}

/** Extrae los segundos sugeridos de espera del texto de un error 429. */
function retryAfterSeconds(raw: string): number | undefined {
  const match = /try again in ([\d.]+)\s*s/i.exec(raw) ?? /retry after ([\d.]+)/i.exec(raw);
  if (!match?.[1]) return undefined;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds) : undefined;
}
