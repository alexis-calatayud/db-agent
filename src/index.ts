import { note } from './cli/render';
import { runRepl } from './cli/repl';
import { createRuntime } from './runtime';
import { ConfigError } from './utils/errors';

async function main(): Promise<void> {
  const runtime = await createRuntime({ notify: note });

  try {
    await runRepl(runtime);
  } finally {
    await runtime.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`\nError de configuracion: ${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}
