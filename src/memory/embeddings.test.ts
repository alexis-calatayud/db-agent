import { afterEach, describe, expect, it } from 'bun:test';
import type { AppConfig } from '../config/types';
import { createEmbedder } from './embeddings';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function configWith(embeddingsModel: string): AppConfig {
  return {
    apiKey: 'sk-test',
    baseUrl: 'https://ejemplo.test/v1',
    model: 'modelo-chat',
    temperature: 0.7,
    maxTokens: 2048,
    requestsPerMinute: 25,
    systemPrompt: 'sys',
    logLevel: 'info',
    maxSteps: 8,
    memory: {
      dbPath: ':memory:',
      embeddingsModel,
      embeddingsBaseUrl: 'https://ejemplo.test/v1',
      autoRecall: 4,
    },
    web: { searchModel: '', baseUrl: 'http://127.0.0.1/v1' },
  };
}

/** Sustituye fetch y registra las peticiones que se hacen. */
function stubFetch(handler: (body: unknown) => Response): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    state.calls++;
    return handler(JSON.parse(String(init?.body ?? '{}')));
  }) as unknown as typeof fetch;
  return state;
}

const okResponse = (vectors: number[][]) =>
  Response.json({ data: vectors.map((embedding, index) => ({ embedding, index })) });

describe('createEmbedder', () => {
  it('no se crea si EMBEDDINGS_MODEL esta vacio: modo solo FTS5', () => {
    expect(createEmbedder(configWith(''), () => {})).toBeUndefined();
    expect(createEmbedder(configWith('   '), () => {})).toBeUndefined();
  });

  it('llama al endpoint correcto y devuelve Float32Array', async () => {
    let urlUsed = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      urlUsed = String(url);
      return okResponse([[1, 0, 0]]);
    }) as unknown as typeof fetch;

    const embedder = createEmbedder(configWith('text-embedding-3-small'), () => {})!;
    const vectors = await embedder.embed(['hola']);

    expect(urlUsed).toBe('https://ejemplo.test/v1/embeddings');
    expect(vectors![0]).toBeInstanceOf(Float32Array);
    expect(Array.from(vectors![0]!)).toEqual([1, 0, 0]);
  });

  it('respeta el indice que devuelve la API, no el orden de llegada', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: [
          { embedding: [2], index: 1 },
          { embedding: [1], index: 0 },
        ],
      })) as unknown as typeof fetch;

    const embedder = createEmbedder(configWith('m'), () => {})!;
    const vectors = await embedder.embed(['primero', 'segundo']);

    expect(Array.from(vectors![0]!)).toEqual([1]);
    expect(Array.from(vectors![1]!)).toEqual([2]);
  });
});

describe('degradacion a FTS5', () => {
  it('un 404 desactiva la busqueda semantica y explica que Groq no los ofrece', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    const reasons: string[] = [];
    const embedder = createEmbedder(configWith('m'), reason => reasons.push(reason))!;

    expect(await embedder.embed(['x'])).toBeNull();
    expect(embedder.available).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('404');
    expect(reasons[0]).toContain('Groq');
  });

  it('un 401 tambien lo desactiva', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }));
    const reasons: string[] = [];
    const embedder = createEmbedder(configWith('m'), reason => reasons.push(reason))!;

    expect(await embedder.embed(['x'])).toBeNull();
    expect(embedder.available).toBe(false);
    expect(reasons[0]).toContain('401');
  });

  it('un fallo de red lo desactiva sin propagar la excepcion', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const reasons: string[] = [];
    const embedder = createEmbedder(configWith('m'), reason => reasons.push(reason))!;

    expect(await embedder.embed(['x'])).toBeNull();
    expect(reasons[0]).toContain('fetch failed');
  });

  it('el aviso sale una sola vez, y no se vuelve a llamar a la API', async () => {
    const state = stubFetch(() => new Response('', { status: 404 }));
    const reasons: string[] = [];
    const embedder = createEmbedder(configWith('m'), reason => reasons.push(reason))!;

    await embedder.embed(['a']);
    await embedder.embed(['b']);
    await embedder.embed(['c']);

    expect(reasons).toHaveLength(1);
    expect(state.calls).toBe(1); // tras el primer fallo ya no se insiste
  });

  it('rechaza una respuesta con menos vectores de los pedidos', async () => {
    stubFetch(() => okResponse([[1]]));
    const reasons: string[] = [];
    const embedder = createEmbedder(configWith('m'), reason => reasons.push(reason))!;

    expect(await embedder.embed(['a', 'b'])).toBeNull();
    expect(reasons[0]).toContain('formato esperado');
  });

  it('sin textos no llama a la API', async () => {
    const state = stubFetch(() => okResponse([]));
    const embedder = createEmbedder(configWith('m'), () => {})!;

    expect(await embedder.embed([])).toEqual([]);
    expect(state.calls).toBe(0);
  });
});
