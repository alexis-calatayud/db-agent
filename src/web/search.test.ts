import { afterEach, describe, expect, it } from 'bun:test';
import type { AppConfig } from '../config/types';
import { createSearcher } from './search';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function configWith(searchModel: string): AppConfig {
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
      embeddingsModel: '',
      embeddingsBaseUrl: 'https://ejemplo.test/v1',
      autoRecall: 0,
    },
    web: { searchModel, baseUrl: 'https://ejemplo.test/v1' },
  };
}

interface Captured {
  calls: number;
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(handler: () => Response): Captured {
  const captured: Captured = { calls: 0, url: '', body: {} };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.calls++;
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body ?? '{}'));
    return handler();
  }) as unknown as typeof fetch;
  return captured;
}

const answerWith = (content: string, citations: Array<[string, string]> = []) =>
  Response.json({
    choices: [
      {
        message: {
          content,
          annotations: citations.map(([title, url]) => ({
            type: 'url_citation',
            url_citation: { title, url },
          })),
        },
      },
    ],
  });

describe('createSearcher', () => {
  it('no se crea si WEB_SEARCH_MODEL esta vacio', () => {
    expect(createSearcher(configWith(''), () => {})).toBeUndefined();
    expect(createSearcher(configWith('   '), () => {})).toBeUndefined();
  });

  it('llama a chat/completions del endpoint configurado', async () => {
    const captured = stubFetch(() => answerWith('respuesta'));
    const searcher = createSearcher(configWith('gpt-4o-mini-search-preview'), () => {})!;
    await searcher.search('precio del gas');

    expect(captured.url).toBe('https://ejemplo.test/v1/chat/completions');
    expect(captured.body['model']).toBe('gpt-4o-mini-search-preview');
  });

  it('usa max_completion_tokens y no manda temperature', async () => {
    // Los modelos de busqueda rechazan max_tokens y temperature.
    const captured = stubFetch(() => answerWith('respuesta'));
    await createSearcher(configWith('m'), () => {})!.search('algo');

    expect(captured.body['max_completion_tokens']).toBeGreaterThan(0);
    expect(captured.body).not.toHaveProperty('max_tokens');
    expect(captured.body).not.toHaveProperty('temperature');
  });

  it('devuelve el resumen y las fuentes', async () => {
    stubFetch(() =>
      answerWith('El TTF ronda los 63 EUR/MWh.', [
        ['Selectra — precio TTF', 'https://selectra.nl/ttf'],
        ['Reuters', 'https://reuters.com/gas'],
      ]),
    );
    const result = await createSearcher(configWith('m'), () => {})!.search('precio TTF');

    expect(result?.answer).toBe('El TTF ronda los 63 EUR/MWh.');
    expect(result?.sources).toEqual([
      { title: 'Selectra — precio TTF', url: 'https://selectra.nl/ttf' },
      { title: 'Reuters', url: 'https://reuters.com/gas' },
    ]);
  });

  it('no repite una misma URL citada varias veces', async () => {
    stubFetch(() =>
      answerWith('texto', [
        ['Fuente', 'https://ejemplo.com/a'],
        ['Fuente otra vez', 'https://ejemplo.com/a'],
        ['Distinta', 'https://ejemplo.com/b'],
      ]),
    );
    const result = await createSearcher(configWith('m'), () => {})!.search('x');

    expect(result?.sources.map(s => s.url)).toEqual([
      'https://ejemplo.com/a',
      'https://ejemplo.com/b',
    ]);
  });

  it('usa la URL como titulo si la cita no trae ninguno', async () => {
    stubFetch(() =>
      Response.json({
        choices: [
          {
            message: {
              content: 'texto',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://sin-titulo.test' } }],
            },
          },
        ],
      }),
    );
    const result = await createSearcher(configWith('m'), () => {})!.search('x');

    expect(result?.sources[0]).toEqual({
      title: 'https://sin-titulo.test',
      url: 'https://sin-titulo.test',
    });
  });

  it('recorta respuestas desmesuradas para no desbordar el contexto', async () => {
    stubFetch(() => answerWith('x'.repeat(9000)));
    const result = await createSearcher(configWith('m'), () => {})!.search('x');

    expect(result!.answer.length).toBeLessThan(4100);
    expect(result!.answer.endsWith('…')).toBe(true);
  });
});

describe('degradacion', () => {
  it('un 404 la desactiva y explica que Groq no tiene modelos de busqueda', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    const reasons: string[] = [];
    const searcher = createSearcher(configWith('gpt-4o-mini-search-preview'), r => reasons.push(r))!;

    expect(await searcher.search('x')).toBeNull();
    expect(searcher.available).toBe(false);
    expect(reasons[0]).toContain('404');
    expect(reasons[0]).toContain('Groq');
  });

  it('el aviso sale una vez y despues ya no se llama a la API', async () => {
    const captured = stubFetch(() => new Response('', { status: 500 }));
    const reasons: string[] = [];
    const searcher = createSearcher(configWith('m'), r => reasons.push(r))!;

    await searcher.search('a');
    await searcher.search('b');

    expect(reasons).toHaveLength(1);
    expect(captured.calls).toBe(1);
  });

  it('un fallo de red la desactiva sin propagar la excepcion', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const reasons: string[] = [];
    const searcher = createSearcher(configWith('m'), r => reasons.push(r))!;

    expect(await searcher.search('x')).toBeNull();
    expect(reasons[0]).toContain('fetch failed');
  });

  it('una respuesta vacia no la desactiva: puede ser una busqueda sin resultados', async () => {
    stubFetch(() => Response.json({ choices: [{ message: { content: '' } }] }));
    const reasons: string[] = [];
    const searcher = createSearcher(configWith('m'), r => reasons.push(r))!;

    const result = await searcher.search('algo rarisimo');
    expect(result).toEqual({ answer: '', sources: [] });
    expect(searcher.available).toBe(true);
    expect(reasons).toHaveLength(0);
  });
});
