import type { AppConfig } from '../config/types';
import { modelQuirks } from '../model/factory';
import type { FriendlyError } from '../utils/errors';

const ESC = '\u001b';
const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const wrap = (code: string) => (text: string) =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const color = {
  dim: wrap('2'),
  bold: wrap('1'),
  cyan: wrap('36'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
};

export const USER_PROMPT = color.green('> ');

export function banner(config: AppConfig, toolCount: number, dbConnected: boolean): string {
  const provider = new URL(config.baseUrl).host;
  const mode =
    toolCount > 0
      ? `agente · ${toolCount} herramienta${toolCount === 1 ? '' : 's'}`
      : 'chat · sin herramientas';

  const rows = [
    color.bold('Agente de consola') + color.dim(`  ·  ${mode}`),
    color.dim(`modelo    ${config.model}`),
    color.dim(`proveedor ${provider}`),
  ];

  if (config.db) {
    const target = new URL(config.db.url);
    const estado = dbConnected ? 'solo lectura' : 'NO DISPONIBLE';
    rows.push(color.dim(`base de datos  ${target.host}${target.pathname} (${estado})`));
  }

  rows.push(color.dim('Escribe /help para ver los comandos.'), '');
  return rows.join('\n');
}

/** Una llamada a tool en curso, para que la espera no sea a ciegas. */
export function renderToolCall(name: string, args: unknown): void {
  let rendered = '';
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    rendered = Object.entries(args as Record<string, unknown>)
      .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ').slice(0, 120)}`)
      .join(', ');
  }
  line(color.dim(`  · ${name}(${rendered})`));
}

export function writeChunk(text: string): void {
  process.stdout.write(text);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function info(text: string): void {
  line(color.cyan(text));
}

export function note(text: string): void {
  line(color.dim(text));
}

export function renderError(error: FriendlyError): void {
  line(color.red(`x ${error.message}`));
  if (error.hint) line(color.dim(`  ${error.hint}`));
}

export function renderUsage(inputTokens: number, outputTokens: number): void {
  note(`  [tokens: ${inputTokens} entrada / ${outputTokens} salida]`);
}

export function renderConfig(config: AppConfig): void {
  const quirks = modelQuirks(config.model);
  const rows: Array<[string, string]> = [
    ['modelo', config.model],
    ['base url', config.baseUrl],
    [
      'temperature',
      quirks.supportsTemperature
        ? String(config.temperature)
        : `1 (fija: ${config.model} no admite otra, se ignora LLM_TEMPERATURE)`,
    ],
    ['max tokens', `${config.maxTokens} (se envia como ${quirks.tokenParam})`],
    ['req/min', String(config.requestsPerMinute)],
    ['log level', config.logLevel],
  ];
  const width = Math.max(...rows.map(([key]) => key.length));
  for (const [key, value] of rows) {
    line(`${color.dim(key.padEnd(width))}  ${value}`);
  }
}
