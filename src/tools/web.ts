import { Tool, tool } from 'smolagents.js';
import type { WebSearcher } from '../web/search';

/**
 * Tool de busqueda en internet.
 *
 * Devuelve el resumen y, por separado, las URLs consultadas. Las fuentes van
 * aparte a proposito: quien busca y redacta es otro modelo, asi que el agente
 * debe poder atribuir lo que afirma en vez de darlo por cierto sin mas.
 */
export function makeWebSearchTool(searcher: WebSearcher): Tool {
  return tool(
    {
      name: 'web_search',
      description:
        'Busca informacion en internet y devuelve un resumen con las fuentes. Usala para datos ' +
        'actuales o externos que no esten en la base de datos ni en la memoria: noticias, ' +
        'precios de mercado publicos, documentacion, normativa. No la uses para nada que puedas ' +
        'obtener con las otras herramientas. Formula la consulta como se la darias a un buscador.',
      inputs: {
        query: {
          type: 'string',
          description:
            'Que buscar, concreto y con las palabras clave relevantes. ' +
            'Ejemplo: "precio spot gas TTF julio 2026".',
        },
      },
      outputType: 'string',
    },
    async ({ query }: { query: string }): Promise<string> => {
      const text = query?.trim();
      if (!text) return 'No se ha buscado nada: la consulta estaba vacia.';

      if (!searcher.available) {
        return 'La busqueda en internet no esta disponible en este proveedor. Responde con lo que ya sepas o dilo.';
      }

      let result;
      try {
        result = await searcher.search(text);
      } catch (error) {
        return `Error al buscar en internet: ${error instanceof Error ? error.message : String(error)}`;
      }

      if (!result) {
        return 'La busqueda en internet no esta disponible en este proveedor. Responde con lo que ya sepas o dilo.';
      }
      if (!result.answer && result.sources.length === 0) {
        return `La busqueda de "${text}" no ha devuelto resultados. Prueba con otras palabras.`;
      }

      const blocks = [result.answer || '(sin resumen)'];
      if (result.sources.length > 0) {
        blocks.push(
          'Fuentes:',
          ...result.sources.map((source, index) => `${index + 1}. ${source.title} — ${source.url}`),
        );
      }
      return blocks.join('\n');
    },
  );
}
