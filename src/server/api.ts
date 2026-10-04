import { runAgentTurn, type TurnEvent } from '../agents/turn';
import { formatMemory } from '../tools/memory';
import type { Runtime } from '../runtime';
import { describeError } from '../utils/errors';
import { SessionStore } from './sessions';

/** Eventos que viajan al navegador, en SSE. */
type WireEvent =
  | TurnEvent
  | { type: 'error'; message: string; hint?: string | undefined; retriable: boolean }
  | { type: 'done' };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

/**
 * CORS abierto a proposito.
 *
 * El servidor no expone la API key ni acepta credenciales de navegador: sirve
 * para que `next dev` (otro puerto) pueda hablar con el. Aun asi, esto no debe
 * publicarse en internet tal cual; ver el README.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};

function sseChunk(event: WireEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Turno del agente convertido en un flujo SSE. */
function streamTurn(runtime: Runtime, sessionId: string, sessions: SessionStore, input: string): Response {
  const session = sessions.get(sessionId);

  if (session.busy) {
    return json({ error: 'Esta sesion ya tiene una pregunta en curso.' }, 409, CORS);
  }
  session.busy = true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: WireEvent) => controller.enqueue(encoder.encode(sseChunk(event)));

      try {
        for await (const event of runAgentTurn({ ...runtime, agent: session.agent }, input)) {
          send(event);
        }
      } catch (error) {
        const described = describeError(error, runtime.config.model);
        send({ type: 'error', ...described });
      } finally {
        session.busy = false;
        send({ type: 'done' });
        controller.close();
      }
    },
    cancel() {
      // El navegador se ha ido. El turno sigue hasta terminar (no hay forma de
      // abortarlo en smolagents), pero la sesion vuelve a quedar libre.
      session.busy = false;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...CORS,
    },
  });
}

export interface ApiOptions {
  runtime: Runtime;
  sessions?: SessionStore;
}

/**
 * Rutas de la API. Se devuelve el handler suelto para poder probarlo sin
 * levantar un puerto.
 */
export function createApi({ runtime, sessions = new SessionStore(runtime) }: ApiOptions) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Que hay disponible: el frontend lo pinta en la cabecera.
    if (path === '/api/info' && request.method === 'GET') {
      return json(
        {
          model: runtime.config.model,
          provider: new URL(runtime.config.baseUrl).host,
          tools: runtime.tools.map(tool => ({ name: tool.name, description: tool.description })),
          database: runtime.config.db
            ? {
                target: `${new URL(runtime.config.db.url).host}${new URL(runtime.config.db.url).pathname}`,
                connected: runtime.schemaSummary !== undefined,
              }
            : null,
          memories: runtime.store.count(),
        },
        200,
        CORS,
      );
    }

    if (path === '/api/memories' && request.method === 'GET') {
      const total = runtime.store.count();
      return json(
        { memories: runtime.store.listRecent(total).map(memory => ({ ...memory, label: formatMemory(memory) })) },
        200,
        CORS,
      );
    }

    const memoryMatch = /^\/api\/memories\/(\d+)$/.exec(path);
    if (memoryMatch && request.method === 'DELETE') {
      const removed = runtime.store.remove(Number(memoryMatch[1]));
      return removed
        ? json({ removed: formatMemory(removed) }, 200, CORS)
        : json({ error: 'No existe esa memoria.' }, 404, CORS);
    }

    if (path === '/api/chat' && request.method === 'POST') {
      let body: { message?: unknown; sessionId?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'El cuerpo debe ser JSON.' }, 400, CORS);
      }

      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';

      if (!message) return json({ error: 'Falta "message".' }, 400, CORS);
      if (!sessionId) return json({ error: 'Falta "sessionId".' }, 400, CORS);

      return streamTurn(runtime, sessionId, sessions, message);
    }

    if (path === '/api/chat' && request.method === 'DELETE') {
      const sessionId = url.searchParams.get('sessionId')?.trim();
      if (!sessionId) return json({ error: 'Falta "sessionId".' }, 400, CORS);
      sessions.reset(sessionId);
      return json({ ok: true }, 200, CORS);
    }

    return json({ error: 'Ruta no encontrada.' }, 404, CORS);
  };
}
