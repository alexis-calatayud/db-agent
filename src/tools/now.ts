import { Tool, tool } from 'smolagents.js';

/** Zona horaria del sistema, usada cuando no se pide otra. */
function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Desplazamiento respecto a UTC, como "GMT+02:00". */
function utcOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  return parts.find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
}

/**
 * Tool de fecha y hora.
 *
 * El reloj se inyecta para que los tests sean deterministas; en produccion es
 * `new Date()`.
 */
export function makeNowTool(clock: () => Date = () => new Date()): Tool {
  return tool(
    {
      name: 'now',
      description:
        'Devuelve la fecha y la hora actuales. Usala siempre que necesites saber que dia u hora es: ' +
        'no lo deduzcas ni lo supongas. Acepta una zona horaria opcional; sin ella usa la del sistema.',
      inputs: {
        timezone: {
          type: 'string',
          description:
            'Zona horaria IANA opcional, por ejemplo "Europe/Madrid", "UTC" o "America/New_York". ' +
            'Omitela para usar la del sistema.',
          nullable: true,
        },
      },
      outputType: 'string',
    },
    async ({ timezone }: { timezone?: string | null }): Promise<string> => {
      const requested = timezone?.trim();
      const zone = requested ? requested : systemTimeZone();

      if (!isValidTimeZone(zone)) {
        return (
          `"${zone}" no es una zona horaria valida. Usa un identificador IANA ` +
          '(por ejemplo "Europe/Madrid", "UTC" o "America/New_York"), u omite el parametro.'
        );
      }

      const date = clock();
      const legible = new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'full',
        timeStyle: 'medium',
        timeZone: zone,
      }).format(date);

      return [
        `${legible} (${zone}, ${utcOffset(date, zone)})`,
        `UTC: ${date.toISOString()}`,
      ].join('\n');
    },
  );
}
