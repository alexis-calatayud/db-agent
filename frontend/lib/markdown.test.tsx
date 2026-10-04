import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from './markdown';

/** Renderiza a HTML plano para poder afirmar sobre la estructura. */
const html = (source: string) => renderToStaticMarkup(<>{renderMarkdown(source)}</>);

describe('tablas', () => {
  /** La tabla que devolvio el agente al preguntarle por los market makers. */
  const TABLA = `En la BD constan estos market makers:

| Código | Market maker | Tipo | País |
|---|---|---|---|
| M1 | NATURGY COMMODITIES TRADING | mandatory | ES |
| M2 | Endesa Energía, S.A. | mandatory | ES |`;

  it('la convierte en una tabla de verdad, no en lineas sueltas', () => {
    const output = html(TABLA);

    expect(output).toContain('<table>');
    expect(output).toContain('<th');
    expect(output).toContain('Código');
    expect(output).toContain('<td');
    expect(output).toContain('NATURGY COMMODITIES TRADING');
    // El separador |---| no debe acabar pintado como texto.
    expect(output).not.toContain('|---|');
  });

  it('mantiene todas las filas y columnas', () => {
    const output = html(TABLA);

    // [\s>] para no contar tambien <thead>.
    expect(output.match(/<th[\s>]/g)).toHaveLength(4);
    expect(output.match(/<tr[\s>]/g)).toHaveLength(3); // cabecera + 2 filas
    expect(output.match(/<td[\s>]/g)).toHaveLength(8);
  });

  it('conserva el texto de alrededor', () => {
    expect(html(TABLA)).toContain('En la BD constan estos market makers');
  });

  it('respeta la alineacion que marca el separador', () => {
    const output = html(`| izq | centro | der |
|:---|:---:|---:|
| a | b | c |`);

    expect(output).toContain('text-align:left');
    expect(output).toContain('text-align:center');
    expect(output).toContain('text-align:right');
  });

  it('funciona sin las barras de los extremos', () => {
    const output = html(`a | b\n--- | ---\n1 | 2`);

    expect(output).toContain('<table>');
    expect(output).toContain('<td');
  });

  it('rellena las celdas que falten en una fila corta', () => {
    const output = html(`| a | b | c |\n|---|---|---|\n| 1 |`);

    expect(output).toContain('<table>');
    expect(output.match(/<td[\s>]/g)).toHaveLength(3);
  });

  it('aplica negrita y codigo dentro de las celdas', () => {
    const output = html(`| campo | valor |\n|---|---|\n| **id** | \`uuid\` |`);

    expect(output).toContain('<strong>id</strong>');
    expect(output).toContain('<code>uuid</code>');
  });

  it('no confunde un parrafo con barras con una tabla', () => {
    const output = html('El operador | separa alternativas, como en a | b.');

    expect(output).not.toContain('<table>');
    expect(output).toContain('<p>');
  });

  it('no trata como tabla una cabecera sin separador', () => {
    expect(html('| a | b |\n| 1 | 2 |')).not.toContain('<table>');
  });
});

describe('enlaces', () => {
  const OBRA =
    'Te recomiendo [Pensamiento Circular](https://flecha.es/obras-de-alicia-moneva/pensamiento-circular), de Alicia Moneva.';

  it('convierte el markdown en un enlace que abre en pestanya nueva', () => {
    const output = html(OBRA);

    expect(output).toContain('href="https://flecha.es/obras-de-alicia-moneva/pensamiento-circular"');
    expect(output).toContain('target="_blank"');
    expect(output).toContain('>Pensamiento Circular</a>');
  });

  it('acompanya target="_blank" de rel="noopener noreferrer"', () => {
    // Sin rel, la pagina abierta puede manipular la nuestra via window.opener.
    expect(html(OBRA)).toContain('rel="noopener noreferrer"');
  });

  it('conserva el texto de alrededor', () => {
    const output = html(OBRA);
    expect(output).toContain('Te recomiendo');
    expect(output).toContain('de Alicia Moneva.');
  });

  it('enlaza tambien una URL suelta, sin sintaxis markdown', () => {
    const output = html('Ficha: https://flecha.es/obras-de-pasquin/matrix');

    expect(output).toContain('href="https://flecha.es/obras-de-pasquin/matrix"');
    expect(output).toContain('target="_blank"');
  });

  it('no deja pasar esquemas peligrosos: quedan como texto', () => {
    for (const source of [
      '[pincha](javascript:alert(1))',
      '[pincha](data:text/html,<script>alert(1)</script>)',
      '[pincha](vbscript:msgbox)',
    ]) {
      const output = html(source);
      // Lo que importa es que no sea pinchable. Que el texto siga ahi es
      // inofensivo: React lo escapa y no se ejecuta nada.
      expect(output).not.toContain('<a ');
      expect(output).not.toContain('href=');
    }
  });

  it('funciona dentro de una celda de tabla', () => {
    const output = html(
      `| Obra | Ficha |\n|---|---|\n| Matrix | [ver](https://flecha.es/obras-de-pasquin/matrix) |`,
    );

    expect(output).toContain('<table>');
    expect(output).toContain('target="_blank"');
  });

  it('convive con negrita y codigo en la misma linea', () => {
    const output = html('**Obra**: [Matrix](https://flecha.es/x/matrix) en `artworks`.');

    expect(output).toContain('<strong>Obra</strong>');
    expect(output).toContain('<code>artworks</code>');
    expect(output).toContain('target="_blank"');
  });

  it('usa la URL como texto si la etiqueta viene vacia', () => {
    expect(html('[](https://flecha.es/x)')).toContain('>https://flecha.es/x</a>');
  });
});

describe('resto del markdown', () => {
  it('sigue pintando bloques de codigo', () => {
    const output = html('Consulta usada:\n```sql\nSELECT 1\n```');

    expect(output).toContain('<pre>');
    expect(output).toContain('SELECT 1');
    expect(output).not.toContain('```');
  });

  it('no interpreta una tabla que este dentro de un bloque de codigo', () => {
    const output = html('```\n| a |\n|---|\n```');

    expect(output).toContain('<pre>');
    expect(output).not.toContain('<table>');
  });

  it('sigue pintando negrita y codigo en linea', () => {
    const output = html('Son **10** filas en `venue`.');

    expect(output).toContain('<strong>10</strong>');
    expect(output).toContain('<code>venue</code>');
  });

  it('no interpreta el texto del modelo como HTML', () => {
    // Se construyen nodos de React, asi que el marcado se escapa siempre.
    expect(html('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('aguanta la entrada vacia', () => {
    expect(renderMarkdown('')).toEqual([]);
    expect(renderMarkdown('   ')).toEqual([]);
  });
});
