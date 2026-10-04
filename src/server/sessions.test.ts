import { describe, expect, it } from 'bun:test';
import type { ToolCallingAgent } from 'smolagents.js';
import type { Runtime } from '../runtime';
import { SessionStore } from './sessions';

/** Runtime falso: solo hace falta que sepa fabricar agentes distinguibles. */
function fakeRuntime(): { runtime: Runtime; created: () => number } {
  let created = 0;
  const runtime = {
    newAgent: () => {
      created++;
      return { id: created, memory: { reset: () => {} } } as unknown as ToolCallingAgent;
    },
  } as unknown as Runtime;
  return { runtime, created: () => created };
}

describe('SessionStore', () => {
  it('devuelve el mismo agente para el mismo id', () => {
    const { runtime, created } = fakeRuntime();
    const sessions = new SessionStore(runtime);

    const first = sessions.get('a');
    const second = sessions.get('a');

    expect(second).toBe(first);
    expect(created()).toBe(1);
  });

  it('da un agente distinto a cada sesion: dos pestanyas no comparten conversacion', () => {
    const { runtime, created } = fakeRuntime();
    const sessions = new SessionStore(runtime);

    expect(sessions.get('a').agent).not.toBe(sessions.get('b').agent);
    expect(created()).toBe(2);
    expect(sessions.size).toBe(2);
  });

  it('descarta las sesiones inactivas', () => {
    let now = 1_000;
    const { runtime } = fakeRuntime();
    const sessions = new SessionStore(runtime, { idleMs: 100, clock: () => now });

    sessions.get('vieja');
    now += 500;
    sessions.get('nueva');

    expect(sessions.size).toBe(1);
  });

  it('no descarta una sesion con un turno en curso', () => {
    let now = 1_000;
    const { runtime } = fakeRuntime();
    const sessions = new SessionStore(runtime, { idleMs: 100, clock: () => now });

    sessions.get('ocupada').busy = true;
    now += 500;
    sessions.get('otra');

    expect(sessions.size).toBe(2);
  });

  it('usarla renueva su antiguedad', () => {
    let now = 1_000;
    const { runtime } = fakeRuntime();
    const sessions = new SessionStore(runtime, { idleMs: 100, clock: () => now });

    const original = sessions.get('a');
    now += 50;
    sessions.get('a'); // la refresca
    now += 60;
    sessions.get('b');

    expect(sessions.get('a')).toBe(original);
  });

  it('respeta el tope de sesiones tirando la mas antigua', () => {
    let now = 0;
    const { runtime } = fakeRuntime();
    const sessions = new SessionStore(runtime, { max: 2, clock: () => now++ });

    sessions.get('a');
    sessions.get('b');
    sessions.get('c');

    expect(sessions.size).toBe(2);
  });

  it('reset() y remove() no fallan con un id desconocido', () => {
    const { runtime } = fakeRuntime();
    const sessions = new SessionStore(runtime);

    expect(() => sessions.reset('fantasma')).not.toThrow();
    expect(() => sessions.remove('fantasma')).not.toThrow();
  });
});
