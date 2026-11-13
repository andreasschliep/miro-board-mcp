/** Which Mermaid diagram a code block holds, from its first line after front matter and comments. */

export type MermaidKind = 'wardley' | 'flowchart' | string;

export function firstCodeLine(code: string): string {
  const withoutFrontMatter = code.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
  const first = withoutFrontMatter
    .split('\n')
    .find((line) => line.trim() && !line.trim().startsWith('%%'));
  return (first ?? '').trim();
}

export function mermaidKind(code: string): MermaidKind {
  const word = firstCodeLine(code).split(/\s+/)[0] ?? '';
  if (word === 'wardley-beta') return 'wardley';
  if (word === 'flowchart' || word === 'graph') return 'flowchart';
  return word;
}

/** True when the block names some diagram type, supported or not. */
export function isMermaidKind(kind: MermaidKind): boolean {
  return /^[A-Za-z][\w-]*$/.test(kind);
}
