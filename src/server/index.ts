import { createRuntime } from '../runtime';
import { ConfigError } from '../utils/errors';
import { createApi } from './api';

const PORT = Number(process.env['PORT'] ?? 3001);

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const handle = createApi({ runtime });

  const server = Bun.serve({
    port: PORT,
    // Un turno del agente encadena varias llamadas al modelo y puede tardar.
    idleTimeout: 240,
    fetch: handle,
  });

  const provider = new URL(runtime.config.baseUrl).host;
  process.stdout.write(
    [
      `API del agente en http://localhost:${server.port}`,
      `  modelo       ${runtime.config.model} (${provider})`,
      `  herramientas ${runtime.tools.map(tool => tool.name).join(', ')}`,
      '',
      'Frontend:  cd frontend && bun run dev',
      '',
    ].join('\n'),
  );

  const shutdown = async () => {
    await server.stop(true);
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`\nError de configuracion: ${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}
