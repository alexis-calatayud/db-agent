import { describe, expect, it } from 'bun:test';
import type { SearchResult, WebSearcher } from '../web/search';
import { makeWebSearchTool } from './web';

/** Buscador falso: ni red ni coste. */
function fakeSearcher(
  result: SearchResult | null,
  overrides: Partial<WebSearcher> = {},
): WebSearcher {
  return {
    model: 'falso',
    available: true,
    search: async () => result,
    ...overrides,
  } as WebSearcher;
}

describe('web_search', () => {
  it('devuelve el resumen con las fuentes numeradas', async () => {
    const tool = makeWebSearchTool(
      fakeSearcher({
        answer: 'El TTF ronda los 63 EUR/MWh.',
        sources: [
          { title: 'Selectra', url: 'https://selectra.nl/ttf' },
          { title: 'Reuters', url: 'https://reuters.com/gas' },
        ],
      }),
    );

    const output = await tool.call({ query: 'precio TTF' });
    expect(output).toContain('El TTF ronda los 63 EUR/MWh.');
    expect(output).toContain('Fuentes:');
    expect(output).toContain('1. Selectra — https://selectra.nl/ttf');
    expect(output).toContain('2. Reuters — https://reuters.com/gas');
  });

  it('funciona aunque no haya citas', async () => {
    const tool = makeWebSearchTool(fakeSearcher({ answer: 'Una respuesta sin citas.', sources: [] }));

    const output = await tool.call({ query: 'algo' });
    expect(output).toBe('Una respuesta sin citas.');
    expect(output).not.toContain('Fuentes:');
  });

  it('avisa cuando la busqueda no ha dado nada', async () => {
    const tool = makeWebSearchTool(fakeSearcher({ answer: '', sources: [] }));

    const output = await tool.call({ query: 'xyzzy inexistente' });
    expect(output).toContain('no ha devuelto resultados');
    expect(output).toContain('xyzzy inexistente');
  });

  it('rechaza una consulta vacia sin gastar una llamada', async () => {
    let llamadas = 0;
    const tool = makeWebSearchTool(
      fakeSearcher(null, {
        search: async () => {
          llamadas++;
          return null;
        },
      }),
    );

    expect(await tool.call({ query: '   ' })).toContain('la consulta estaba vacia');
    expect(llamadas).toBe(0);
  });

  it('lo dice claramente si el proveedor no puede buscar', async () => {
    const desactivado = makeWebSearchTool(fakeSearcher(null, { available: false }));
    expect(await desactivado.call({ query: 'algo' })).toContain('no esta disponible');

    // available true pero la busqueda devuelve null: acaba de desactivarse.
    const recienCaido = makeWebSearchTool(fakeSearcher(null));
    expect(await recienCaido.call({ query: 'algo' })).toContain('no esta disponible');
  });

  it('un error inesperado se devuelve como observacion, no tumba el turno', async () => {
    const tool = makeWebSearchTool(
      fakeSearcher(null, {
        search: async () => {
          throw new Error('algo raro paso');
        },
      }),
    );

    const output = await tool.call({ query: 'algo' });
    expect(output).toContain('Error al buscar en internet');
    expect(output).toContain('algo raro paso');
  });

  it('declara query como obligatorio y de tipo string', () => {
    const tool = makeWebSearchTool(fakeSearcher(null));
    expect(tool.inputs['query']?.['type']).toBe('string');
    expect(tool.inputs['query']?.['nullable']).toBeUndefined();
  });
});
