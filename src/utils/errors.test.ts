import { describe, expect, it } from 'bun:test';
import { describeError } from './errors';

const apiError = (status: number, message = 'boom') => Object.assign(new Error(message), { status });

describe('describeError', () => {
  it('traduce 401 y 403 a un problema de API key, no reintentable', () => {
    for (const status of [401, 403]) {
      const result = describeError(apiError(status), 'modelo-x');
      expect(result.message).toMatch(/API key invalida/);
      expect(result.hint).toMatch(/LLM_API_KEY/);
      expect(result.retriable).toBe(false);
    }
  });

  it('traduce 404 nombrando el modelo configurado', () => {
    const result = describeError(apiError(404), 'llama-inexistente');
    expect(result.message).toContain('llama-inexistente');
    expect(result.hint).toMatch(/LLM_MODEL/);
    expect(result.retriable).toBe(false);
  });

  it('traduce 429 y extrae los segundos de espera cuando el proveedor los indica', () => {
    const withDelay = describeError(apiError(429, 'Rate limit reached. Please try again in 7.2s'), 'm');
    expect(withDelay.message).toMatch(/rate limit/i);
    expect(withDelay.hint).toContain('8s');
    expect(withDelay.retriable).toBe(true);

    const withoutDelay = describeError(apiError(429), 'm');
    expect(withoutDelay.hint).toMatch(/LLM_MAX_TOKENS/);
    expect(withoutDelay.retriable).toBe(true);
  });

  it('marca los 5xx como transitorios', () => {
    const result = describeError(apiError(503), 'm');
    expect(result.message).toContain('503');
    expect(result.retriable).toBe(true);
  });

  it('trata los errores sin status como fallo de red, reintentable', () => {
    const result = describeError(new TypeError('fetch failed'), 'm');
    expect(result.message).toMatch(/No se ha podido contactar/);
    expect(result.hint).toContain('fetch failed');
    expect(result.retriable).toBe(true);
  });

  it('explica el 400 de tool calling en vez de tratarlo como fallo generico', () => {
    const result = describeError(apiError(400, 'tool_use_failed'), 'llama-3.3-70b-versatile');
    expect(result.message).toContain('llama-3.3-70b-versatile');
    expect(result.hint).toMatch(/LLM_MODEL/);
    expect(result.retriable).toBe(true);
  });

  it('recupera el codigo de estado que el agente pierde al envolver el error', () => {
    // AgentGenerationError conserva el codigo solo dentro del texto.
    class AgentGenerationError extends Error {}
    const wrapped = new AgentGenerationError(
      'Error while generating output:\n429 Rate limit reached. Please try again in 3s',
    );
    const result = describeError(wrapped, 'm');
    expect(result.message).toMatch(/rate limit/i);
    expect(result.hint).toContain('3s');
  });

  it('distingue quedarse sin pasos de un fallo de la API', () => {
    class AgentMaxStepsError extends Error {}
    const result = describeError(new AgentMaxStepsError('Reached max steps'), 'm');
    expect(result.message).toMatch(/agotado sus pasos/);
    expect(result.hint).toMatch(/AGENT_MAX_STEPS/);
    expect(result.retriable).toBe(true);
  });

  it('no lanza ante valores que no son Error', () => {
    expect(() => describeError('algo raro', 'm')).not.toThrow();
    expect(() => describeError(null, 'm')).not.toThrow();
  });
});
