import { describe, expect, it } from 'bun:test';
import type { ToolCallingAgent } from 'smolagents.js';
import { MemoryStore } from '../memory/store';
import type { Runtime } from '../runtime';
import { createApi } from './api';
import { SessionStore } from './sessions';

/**
 * Runtime falso con un agente que emite una secuencia fija de pasos. Ni red ni
 * modelo: se comprueba el transporte, no el agente.
 */
function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  const store = new MemoryStore(':memory:');

  const agent = {
    memory: { reset: () => {} },
    async run() {
      return (async function* () {
        yield Object.assign(Object.create({ constructor: { name: 'x' } }), {});
      })();
    },
  } as unknown as ToolCallingAgent;

  return {
    config: {
      model: 'modelo-falso',
      baseUrl: 'https://ejemplo.test/v1',
      memory: { autoRecall: 0 },
    },
    store,
    tools: [
      { name: 'now', description: 'fecha y hora' },
      { name: 'remember', description: 'guarda' },
    ],
    schemaSummary: undefined,
    newAgent: () => agent,
    close: async () => store.close(),
    ...overrides,
  } as unknown as Runtime;
}

const post = (body: unknown) =>
  new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /api/info', () => {
  it('describe modelo, proveedor y herramientas', async () => {
    const runtime = fakeRuntime();
    const response = await createApi({ runtime })(new Request('http://localhost/api/info'));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body['model']).toBe('modelo-falso');
    expect(body['provider']).toBe('ejemplo.test');
    expect(body['tools']).toHaveLength(2);
    expect(body['database']).toBeNull();
    await runtime.close();
  });

  it('marca la base como no conectada si no hubo catalogo', async () => {
    const runtime = fakeRuntime({
      config: {
        model: 'm',
        baseUrl: 'https://ejemplo.test/v1',
        memory: { autoRecall: 0 },
        db: { url: 'postgres://u:p@servidor:5432/base' },
      },
    } as unknown as Partial<Runtime>);

    const response = await createApi({ runtime })(new Request('http://localhost/api/info'));
    const body = (await response.json()) as { database: { target: string; connected: boolean } };

    expect(body.database.target).toBe('servidor:5432/base');
    expect(body.database.connected).toBe(false);
    await runtime.close();
  });
});

describe('POST /api/chat', () => {
  it('exige message y sessionId', async () => {
    const runtime = fakeRuntime();
    const handle = createApi({ runtime });

    expect((await handle(post({ sessionId: 'a' }))).status).toBe(400);
    expect((await handle(post({ message: 'hola' }))).status).toBe(400);
    expect((await handle(post({ sessionId: ' ', message: 'hola' }))).status).toBe(400);
    await runtime.close();
  });

  it('rechaza un cuerpo que no sea JSON', async () => {
    const runtime = fakeRuntime();
    const response = await createApi({ runtime })(
      new Request('http://localhost/api/chat', { method: 'POST', body: 'no soy json' }),
    );

    expect(response.status).toBe(400);
    await runtime.close();
  });

  it('responde como SSE', async () => {
    const runtime = fakeRuntime();
    const response = await createApi({ runtime })(post({ sessionId: 'a', message: 'hola' }));

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('data: ');
    await runtime.close();
  });

  it('cierra siempre con un evento done, aunque el turno falle', async () => {
    const runtime = fakeRuntime();
    // Un agente que revienta: el cliente debe enterarse y no quedarse colgado.
    runtime.newAgent = () =>
      ({
        memory: { reset: () => {} },
        run: async () => {
          throw new Error('el agente ha fallado');
        },
      }) as unknown as ToolCallingAgent;

    const text = await (await createApi({ runtime })(post({ sessionId: 'a', message: 'x' }))).text();

    expect(text).toContain('"type":"error"');
    expect(text.trimEnd().endsWith('data: {"type":"done"}')).toBe(true);
    await runtime.close();
  });

  it('rechaza con 409 una segunda pregunta en la misma sesion', async () => {
    const runtime = fakeRuntime();
    const sessions = new SessionStore(runtime);
    sessions.get('ocupada').busy = true;

    const response = await createApi({ runtime, sessions })(
      post({ sessionId: 'ocupada', message: 'hola' }),
    );

    expect(response.status).toBe(409);
    await runtime.close();
  });
});

describe('memorias y sesiones', () => {
  it('lista las memorias', async () => {
    const runtime = fakeRuntime();
    runtime.store.save({ content: 'una memoria' });

    const response = await createApi({ runtime })(new Request('http://localhost/api/memories'));
    const body = (await response.json()) as { memories: Array<{ label: string }> };

    expect(body.memories[0]?.label).toContain('una memoria');
    await runtime.close();
  });

  it('borra por id, y devuelve 404 si no existe', async () => {
    const runtime = fakeRuntime();
    const saved = runtime.store.save({ content: 'efimera' });
    const handle = createApi({ runtime });

    const del = (id: number) =>
      handle(new Request(`http://localhost/api/memories/${id}`, { method: 'DELETE' }));

    expect((await del(saved.id)).status).toBe(200);
    expect((await del(saved.id)).status).toBe(404);
    expect(runtime.store.count()).toBe(0);
    await runtime.close();
  });

  it('DELETE /api/chat olvida la conversacion sin tocar la memoria permanente', async () => {
    const runtime = fakeRuntime();
    runtime.store.save({ content: 'debe sobrevivir' });

    const response = await createApi({ runtime })(
      new Request('http://localhost/api/chat?sessionId=a', { method: 'DELETE' }),
    );

    expect(response.status).toBe(200);
    expect(runtime.store.count()).toBe(1);
    await runtime.close();
  });
});

describe('CORS y rutas', () => {
  it('responde al preflight', async () => {
    const runtime = fakeRuntime();
    const response = await createApi({ runtime })(
      new Request('http://localhost/api/chat', { method: 'OPTIONS' }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await runtime.close();
  });

  it('devuelve 404 en una ruta desconocida', async () => {
    const runtime = fakeRuntime();
    const response = await createApi({ runtime })(new Request('http://localhost/api/inexistente'));

    expect(response.status).toBe(404);
    await runtime.close();
  });
});
