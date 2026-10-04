import type { ToolCallingAgent } from 'smolagents.js';
import type { Runtime } from '../runtime';

/** Una conversacion web, con su propio agente. */
export interface Session {
  id: string;
  agent: ToolCallingAgent;
  createdAt: number;
  lastUsedAt: number;
  /** Un turno por sesion a la vez: el agente no es reentrante. */
  busy: boolean;
}

export interface SessionStoreOptions {
  /** Sesiones inactivas mas tiempo del indicado se descartan. */
  idleMs?: number;
  /** Tope de sesiones vivas, para que un cliente que rota ids no llene la RAM. */
  max?: number;
  clock?: () => number;
}

const DEFAULT_IDLE_MS = 60 * 60 * 1000;
const DEFAULT_MAX = 100;

/**
 * Sesiones de la interfaz web.
 *
 * Hace falta porque la memoria de la conversacion vive dentro del agente de
 * smolagents: si dos pestanas compartieran uno, se verian los mensajes de la
 * otra. El modelo, la memoria permanente y las tools si se comparten, que es
 * donde estan los recursos caros.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly runtime: Runtime;
  private readonly idleMs: number;
  private readonly max: number;
  private readonly clock: () => number;

  constructor(runtime: Runtime, options: SessionStoreOptions = {}) {
    this.runtime = runtime;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.max = options.max ?? DEFAULT_MAX;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Devuelve la sesion, creandola si hace falta. */
  get(id: string): Session {
    this.evictExpired();

    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastUsedAt = this.clock();
      return existing;
    }

    if (this.sessions.size >= this.max) this.evictOldest();

    const now = this.clock();
    const session: Session = {
      id,
      agent: this.runtime.newAgent(),
      createdAt: now,
      lastUsedAt: now,
      busy: false,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Olvida la conversacion sin tocar la memoria permanente. */
  reset(id: string): void {
    this.sessions.get(id)?.agent.memory.reset();
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private evictExpired(): void {
    const limit = this.clock() - this.idleMs;
    for (const [id, session] of this.sessions) {
      if (!session.busy && session.lastUsedAt < limit) this.sessions.delete(id);
    }
  }

  private evictOldest(): void {
    let oldest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (session.busy) continue;
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
    }
    if (oldest) this.sessions.delete(oldest.id);
  }
}
