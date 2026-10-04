import type { ReactNode } from 'react';

/**
 * Renderizador minimo de lo que produce el agente: bloques de codigo con
 * ```, `codigo` en linea y **negrita**.
 *
 * Se construyen nodos de React, no HTML, asi que el texto del modelo nunca se
 * interpreta como marcado y no hay riesgo de inyeccion. Es deliberadamente
 * pequenyo: no merece la pena arrastrar una libreria de markdown para esto.
 */

/**
 * Solo http y https.
 *
 * Es lo que impide que un `[texto](javascript:...)` —venga del modelo o, peor,
 * de una pagina que haya leido web_search— acabe siendo ejecutable al pinchar.
 */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url, 'https://example.invalid');
    return ['http:', 'https:'].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Enlace externo: siempre en pestanya nueva. */
function externalLink(label: ReactNode, href: string, key: string): ReactNode {
  return (
    // rel="noopener noreferrer" acompanya siempre a target="_blank": sin el, la
    // pagina abierta puede manipular la nuestra a traves de window.opener.
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

/** Trocea una linea en enlaces, negritas y codigo en linea. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Alterna: texto, [etiqueta](url), **negrita**, `codigo`, URL suelta.
  const pattern = /(\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<>()[\]]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));

    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;

    if (token.startsWith('[')) {
      const markdownLink = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)!;
      const label = markdownLink[1]!;
      const href = safeHref(markdownLink[2]!);
      // Un esquema que no sea http(s) se queda como texto, no como enlace.
      nodes.push(href ? externalLink(label || href, href, key) : token);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      // URL suelta: el modelo no siempre la escribe en markdown.
      const href = safeHref(token);
      nodes.push(href ? externalLink(token, href, key) : token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

type Align = 'left' | 'center' | 'right';

/** Trocea `| a | b |` en sus celdas, tolerando que falten las barras extremas. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

/**
 * Detecta la linea separadora de una tabla (`|---|:---:|`) y saca de ella la
 * alineacion de cada columna. Es lo que distingue una tabla de un parrafo que
 * casualmente lleve barras verticales.
 */
function parseAlignments(line: string): Align[] | null {
  if (!line.includes('-')) return null;

  const cells = splitRow(line);
  if (cells.length === 0) return null;

  const alignments: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-{2,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    alignments.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return alignments;
}

function renderTable(
  header: string[],
  alignments: Align[],
  rows: string[][],
  key: string,
): ReactNode {
  const alignOf = (index: number) => alignments[index] ?? 'left';

  return (
    // Las tablas de la base de datos son anchas: que scrollee la tabla y no la
    // pagina entera.
    <div className="tableWrap" key={key}>
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} style={{ textAlign: alignOf(index) }}>
                {renderInline(cell, `${key}-h${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {header.map((_, index) => (
                <td key={index} style={{ textAlign: alignOf(index) }}>
                  {renderInline(row[index] ?? '', `${key}-r${rowIndex}c${index}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Texto fuera de bloques de codigo: parrafos y tablas. */
function renderTextBlock(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const key = `${keyPrefix}-l${index}`;

    // Una tabla es: cabecera con barras + separador justo debajo.
    const next = lines[index + 1];
    const alignments = line.includes('|') && next !== undefined ? parseAlignments(next) : null;

    if (alignments) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let cursor = index + 2;

      while (cursor < lines.length && lines[cursor]!.includes('|')) {
        rows.push(splitRow(lines[cursor]!));
        cursor++;
      }

      nodes.push(renderTable(header, alignments, rows, key));
      index = cursor - 1;
      continue;
    }

    if (!line.trim()) {
      nodes.push(<br key={key} />);
      continue;
    }

    nodes.push(<p key={key}>{renderInline(line, key)}</p>);
  }

  return nodes;
}

export function renderMarkdown(source: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  // Trozos alternos: fuera de ``` / dentro de ```
  const parts = source.split(/```/);

  parts.forEach((part, partIndex) => {
    const isCode = partIndex % 2 === 1;

    if (isCode) {
      // La primera linea puede ser el lenguaje (```sql).
      const newline = part.indexOf('\n');
      const body = newline === -1 ? part : part.slice(newline + 1);
      blocks.push(
        <pre key={`b${partIndex}`}>
          <code>{body.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }

    // Se quitan solo saltos de linea, no espacios: la indentacion importa.
    const trimmed = part.replace(/^\n+|\n+$/g, '');
    if (!trimmed.trim()) return;

    blocks.push(...renderTextBlock(trimmed, `b${partIndex}`));
  });

  return blocks;
}
