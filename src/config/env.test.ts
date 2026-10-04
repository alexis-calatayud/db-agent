import { describe, expect, it } from 'bun:test';
import { ConfigError } from '../utils/errors';
import { DEFAULTS, loadConfig } from './env';

const minimal = { LLM_API_KEY: 'sk-test' };

describe('loadConfig', () => {
  it('falla con un mensaje accionable si falta LLM_API_KEY', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_API_KEY: '   ' })).toThrow(/Falta LLM_API_KEY/);
  });

  it('aplica los valores por defecto', () => {
    const config = loadConfig(minimal);
    expect(config.apiKey).toBe('sk-test');
    expect(config.baseUrl).toBe(DEFAULTS.baseUrl);
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.temperature).toBe(DEFAULTS.temperature);
    expect(config.maxTokens).toBe(DEFAULTS.maxTokens);
    expect(config.logLevel).toBe('info');
  });

  it('permite cambiar de proveedor solo con variables de entorno', () => {
    const config = loadConfig({
      ...minimal,
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_MODEL: 'qwen/qwen3.6-27b',
    });
    expect(config.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(config.model).toBe('qwen/qwen3.6-27b');
  });

  it('rechaza una base url invalida', () => {
    expect(() => loadConfig({ ...minimal, LLM_BASE_URL: 'no-es-una-url' })).toThrow(
      /LLM_BASE_URL no es una URL valida/,
    );
  });

  it('rechaza numeros mal formados o fuera de rango', () => {
    expect(() => loadConfig({ ...minimal, LLM_TEMPERATURE: 'caliente' })).toThrow(/debe ser un numero/);
    expect(() => loadConfig({ ...minimal, LLM_TEMPERATURE: '5' })).toThrow(/entre 0 y 2/);
    expect(() => loadConfig({ ...minimal, LLM_MAX_TOKENS: '10.5' })).toThrow(/entero/);
    expect(() => loadConfig({ ...minimal, LLM_MAX_TOKENS: '0' })).toThrow(/entre 1 y/);
  });

  it('rechaza un LOG_LEVEL desconocido y normaliza mayusculas', () => {
    expect(() => loadConfig({ ...minimal, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL debe ser uno de/);
    expect(loadConfig({ ...minimal, LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
  });

  it('trata las variables vacias como ausentes', () => {
    const config = loadConfig({ ...minimal, LLM_MODEL: '', LLM_TEMPERATURE: '' });
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.temperature).toBe(DEFAULTS.temperature);
  });
});
