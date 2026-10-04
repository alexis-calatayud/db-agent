import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { ChatMessage, MessageRole } from 'smolagents.js';
import type { AppConfig } from '../config/types';
import { createModel, modelQuirks } from './factory';

/** Cuerpos recibidos por el servidor de pruebas, en orden. */
const received: Array<Record<string, unknown>> = [];

let server: Server<undefined>;

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push((await request.json()) as Record<string, unknown>);

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const text of ['Hola', ', ', 'mundo']) {
            controller.enqueue(
              encoder.encode(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })),
            );
          }
          controller.enqueue(
            encoder.encode(
              sse({
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
              }),
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function configFor(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: 'sk-test',
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model: 'modelo-de-prueba',
    temperature: 0.7,
    maxTokens: 2048,
    requestsPerMinute: 100,
    systemPrompt: 'sys',
    logLevel: 'info',
    maxSteps: 8,
    memory: {
      dbPath: ':memory:',
      embeddingsModel: '',
      embeddingsBaseUrl: 'http://127.0.0.1/v1',
      autoRecall: 0,
    },
    web: { searchModel: '', baseUrl: 'http://127.0.0.1/v1' },
    ...overrides,
  };
}

async function collect(config: AppConfig): Promise<{ text: string; usage: [number, number] }> {
  const model = createModel(config);
  let text = '';
  let usage: [number, number] = [0, 0];

  for await (const delta of model.generateStream({
    messages: [new ChatMessage({ role: MessageRole.USER, content: 'hola' })],
  })) {
    if (delta.content) text += delta.content;
    if (delta.tokenUsage) usage = [delta.tokenUsage.inputTokens, delta.tokenUsage.outputTokens];
  }

  return { text, usage };
}

describe('createModel', () => {
  it('entrega la respuesta por trozos y reporta el consumo de tokens', async () => {
    const { text, usage } = await collect(configFor());
    expect(text).toBe('Hola, mundo');
    expect(usage).toEqual([11, 3]);
  });

  it('inyecta temperature y max_tokens en la peticion', async () => {
    received.length = 0;
    await collect(configFor({ temperature: 0.15, maxTokens: 512 }));

    const body = received.at(-1);
    expect(body?.['temperature']).toBe(0.15);
    expect(body?.['max_tokens']).toBe(512);
    expect(body?.['stream']).toBe(true);
  });

  it('no manda stop sequences: smolagents pide parar en lo que el mismo escribe', async () => {
    received.length = 0;
    await collect(configFor());
    // La libreria deja `stop: null` en el cuerpo; lo que no puede haber es una
    // lista con 'Calling tools:', que dejaria al modelo generando en vacio.
    expect(received.at(-1)?.['stop']).toBeNull();
  });

  it('usa max_completion_tokens y omite temperature con los modelos gpt-5.x', async () => {
    received.length = 0;
    await collect(configFor({ model: 'gpt-5.5', temperature: 0.15, maxTokens: 512 }));

    const body = received.at(-1);
    expect(body?.['max_completion_tokens']).toBe(512);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });
});

describe('modelQuirks', () => {
  it('detecta la familia de razonamiento de OpenAI', () => {
    for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5', 'o1', 'o3-mini', 'o4-mini']) {
      expect(modelQuirks(model)).toEqual({
        tokenParam: 'max_completion_tokens',
        supportsTemperature: false,
      });
    }
  });

  it('mantiene el contrato clasico para el resto de proveedores', () => {
    for (const model of ['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile', 'gpt-4.1', 'gpt-4o']) {
      expect(modelQuirks(model)).toEqual({
        tokenParam: 'max_tokens',
        supportsTemperature: true,
      });
    }
  });

  it('no confunde el gpt-oss de Groq con un modelo de OpenAI', () => {
    // Lleva "gpt" pero no es de la familia gpt-5: acepta max_tokens.
    expect(modelQuirks('openai/gpt-oss-120b').tokenParam).toBe('max_tokens');
    expect(modelQuirks('openai/gpt-oss-20b').supportsTemperature).toBe(true);
  });

  it('usa el modelo y el endpoint de la configuracion, sin nada hardcodeado', async () => {
    received.length = 0;
    await collect(configFor({ model: 'otro-proveedor/otro-modelo' }));

    expect(received.at(-1)?.['model']).toBe('otro-proveedor/otro-modelo');
  });
});
