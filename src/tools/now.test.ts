import { describe, expect, it } from 'bun:test';
import { makeNowTool } from './now';

/** Reloj fijo: 28 de julio de 2026, 17:05:42 UTC (un martes). */
const FIXED = new Date('2026-07-28T17:05:42.000Z');
const nowTool = makeNowTool(() => FIXED);

describe('now', () => {
  it('devuelve la fecha en formato legible y el instante en UTC', async () => {
    const output = await nowTool.call({ timezone: 'UTC' });

    expect(output).toContain('28 de julio de 2026');
    expect(output).toContain('17:05:42');
    expect(output).toContain('UTC: 2026-07-28T17:05:42.000Z');
  });

  it('convierte a la zona horaria que se le pida', async () => {
    const madrid = await nowTool.call({ timezone: 'Europe/Madrid' });
    const tokyo = await nowTool.call({ timezone: 'Asia/Tokyo' });

    // Madrid en julio es UTC+2; Tokio, UTC+9 y ya del dia siguiente.
    expect(madrid).toContain('19:05:42');
    expect(madrid).toContain('GMT+02:00');
    // es-ES no rellena la hora con cero a la izquierda: "2:05:42", no "02:05:42".
    expect(tokyo).toContain('2:05:42');
    expect(tokyo).toContain('miércoles, 29 de julio de 2026');

    // El instante absoluto es el mismo se mire desde donde se mire.
    expect(madrid).toContain('UTC: 2026-07-28T17:05:42.000Z');
    expect(tokyo).toContain('UTC: 2026-07-28T17:05:42.000Z');
  });

  it('usa la zona del sistema cuando no se indica ninguna', async () => {
    const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    for (const args of [{}, { timezone: undefined }, { timezone: null }, { timezone: '  ' }]) {
      expect(await nowTool.call(args)).toContain(systemZone);
    }
  });

  it('explica el fallo en vez de reventar si la zona no existe', async () => {
    const output = await nowTool.call({ timezone: 'Marte/Olympus_Mons' });

    expect(output).toContain('no es una zona horaria valida');
    expect(output).toContain('Europe/Madrid');
  });

  it('declara timezone como opcional, para que el modelo pueda omitirlo', () => {
    expect(nowTool.inputs['timezone']?.['nullable']).toBe(true);
  });

  it('lee el reloj en cada llamada, no una sola vez al construirse', async () => {
    let tick = 0;
    const ticking = makeNowTool(() => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)));

    const first = await ticking.call({ timezone: 'UTC' });
    const second = await ticking.call({ timezone: 'UTC' });
    expect(first).not.toBe(second);
  });
});
