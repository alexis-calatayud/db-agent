import {
  OpenAIServerModel,
  type ChatMessage,
  type PrepareCompletionParams,
} from 'smolagents.js';
import type { AppConfig } from '../config/types';

/** Reintentos cuando el modelo genera una llamada a tool mal formada. */
const TOOL_CALL_RETRIES = 2;

/**
 * Groq devuelve 400 con `code: "tool_use_failed"` cuando el modelo, en vez de
 * emitir una tool call nativa, escribe algo como
 * `<function=describe_table{...}</function>` en el texto, o no genera nada.
 * Es intermitente: el mismo prompt suele funcionar al reintentarlo.
 */
function isMalformedToolCall(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status !== 400) return false;
  return /tool_use_failed|did not call a tool|Failed to call a function/i.test(error.message);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Diferencias de la API segun el modelo. */
export interface ModelQuirks {
  /** Como se llama el limite de tokens de salida en este modelo. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** false si el modelo solo admite su temperatura por defecto. */
  supportsTemperature: boolean;
}

/**
 * Los modelos de razonamiento de OpenAI (gpt-5.x, o1, o3, o4) cambiaron el
 * contrato: rechazan `max_tokens` y exigen `max_completion_tokens`, y solo
 * aceptan la temperatura por defecto. El resto de proveedores
 * OpenAI-compatibles (Groq, OpenRouter, Cerebras) siguen con el contrato
 * clasico.
 *
 * El prefijo se comprueba al principio del id a proposito: en Groq existe
 * `openai/gpt-oss-120b`, que NO es de esta familia y si acepta `max_tokens`.
 */
export function modelQuirks(modelId: string): ModelQuirks {
  const isOpenAiReasoning = /^(gpt-5|o1|o3|o4)/.test(modelId.trim());
  return isOpenAiReasoning
    ? { tokenParam: 'max_completion_tokens', supportsTemperature: false }
    : { tokenParam: 'max_tokens', supportsTemperature: true };
}

/**
 * `OpenAIServerModel` no expone temperature ni max_tokens en su API publica:
 * construye el cuerpo de la peticion a partir de `prepareCompletionParams()`.
 * Extendemos ese metodo para inyectar ambos parametros de muestreo.
 */
class ConsoleModel extends OpenAIServerModel {
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly quirks: ModelQuirks;

  constructor(config: AppConfig) {
    super({
      modelId: config.model,
      apiKey: config.apiKey,
      apiBase: config.baseUrl,
      requestsPerMinute: config.requestsPerMinute,
      // Un turno del agente son varias llamadas seguidas, y los planes
      // gratuitos limitan por tokens/minuto. Con mas reintentos el SDK espera
      // lo que diga la cabecera Retry-After en vez de tumbar el turno entero.
      clientOptions: { maxRetries: 4 },
    });
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.quirks = modelQuirks(config.model);
  }

  override async prepareCompletionParams(
    params: PrepareCompletionParams,
  ): Promise<Record<string, unknown>> {
    const base = await super.prepareCompletionParams(params);

    // `ToolCallingAgent` pide parar en 'Observation:' y 'Calling tools:', que
    // es como smolagents parsea ReAct en texto plano. Pero esas mismas cadenas
    // son las que el propio agente escribe en el historial, asi que el modelo
    // las reproduce, choca con su secuencia de parada y genera una respuesta
    // vacia. Groq lo rechaza con "model did not call a tool". Aqui usamos tool
    // calling nativo, donde las paradas no hacen ninguna falta.
    delete base['stop'];

    return {
      ...base,
      [this.quirks.tokenParam]: this.maxTokens,
      ...(this.quirks.supportsTemperature ? { temperature: this.temperature } : {}),
    };
  }

  /**
   * Reintenta cuando el modelo genera una tool call mal formada.
   *
   * Sin esto un solo tropiezo del modelo mata el turno entero del agente,
   * perdiendo todo el trabajo de los pasos anteriores.
   */
  override async generate(
    params: Parameters<OpenAIServerModel['generate']>[0],
  ): Promise<ChatMessage> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= TOOL_CALL_RETRIES; attempt++) {
      try {
        return await super.generate(params);
      } catch (error) {
        if (!isMalformedToolCall(error)) throw error;
        lastError = error;
        await sleep(400 * (attempt + 1));
      }
    }

    throw lastError;
  }
}

/**
 * Unico punto del codigo que conoce el proveedor concreto. El resto de la
 * aplicacion trabaja contra el tipo `Model` de smolagents.
 */
export function createModel(config: AppConfig): OpenAIServerModel {
  return new ConsoleModel(config);
}
