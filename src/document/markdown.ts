/**
 * Markdown to document model: one frame per "##" heading, blocks in reading order.
 *
 * marked's lexer only tokenises; nothing is rendered or executed. Line numbers come
 * from the raw text of each token, so every finding can point to its line.
 */
import { load } from 'js-yaml';
import { Lexer, type Token, type Tokens } from 'marked';
import { firstCodeLine } from './mermaid.ts';
import { escapeHtml, type Block, type DocFinding, type DocFrame, type DocModel } from './model.ts';

const MERMAID_START = /^(wardley-beta|flowchart|graph)\b/;

/** Front matter at the very top: "---", YAML, "---". Returns its lines and the title. */
function splitFrontMatter(source: string): { body: string; title: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(source);
  if (!match) return { body: source, title: null };
  let title: string | null = null;
  try {
    const data = load(match[1] ?? '') as { title?: unknown } | null;
    if (data && typeof data.title === 'string') title = data.title;
  } catch {
    // Front matter that is not YAML is simply ignored; it is not part of the board.
  }
  // Keep the line count so that line numbers stay right.
  const blankLines = '\n'.repeat(match[0].split('\n').length - 1);
  return { body: blankLines + source.slice(match[0].length), title };
}

export function isMermaid(token: Tokens.Code): boolean {
  if ((token.lang ?? '').trim().toLowerCase() === 'mermaid') return true;
  return MERMAID_START.test(firstCodeLine(token.text));
}

function inlineHtml(tokens: Token[] | undefined, line: number, warnings: DocFinding[]): string {
  let html = '';
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text':
        html +=
          'tokens' in token && token.tokens
            ? inlineHtml(token.tokens, line, warnings)
            : escapeHtml(token.text);
        break;
      case 'escape':
        html += escapeHtml(token.text);
        break;
      case 'strong':
        html += `<strong>${inlineHtml(token.tokens, line, warnings)}</strong>`;
        break;
      case 'em':
        html += `<em>${inlineHtml(token.tokens, line, warnings)}</em>`;
        break;
      case 'del':
        html += `<s>${inlineHtml(token.tokens, line, warnings)}</s>`;
        break;
      case 'codespan':
        html += escapeHtml(token.text);
        break;
      case 'br':
        html += '<br>';
        break;
      case 'link': {
        const label = inlineHtml(token.tokens, line, warnings);
        html += /^https:\/\//.test(token.href)
          ? `<a href="${escapeHtml(token.href)}">${label}</a>`
          : label;
        break;
      }
      case 'image':
        warnings.push({
          line,
          message: `image "${token.href}" is not drawn; boards show no external images.`,
        });
        break;
      default:
        // Inline HTML and anything unknown: keep the visible text only.
        html += escapeHtml(
          ('text' in token && typeof token.text === 'string' ? token.text : token.raw).replace(
            /<[^>]*>/g,
            '',
          ),
        );
    }
  }
  return html;
}

function listItems(list: Tokens.List, line: number, warnings: DocFinding[]): string[] {
  return list.items.map((item, index) => {
    const prefix = list.ordered ? `${Number(list.start || 1) + index}. ` : '';
    const parts: string[] = [];
    for (const token of item.tokens) {
      if (token.type === 'list') {
        for (const child of listItems(token as Tokens.List, line, warnings))
          parts.push(`• ${child}`);
      } else if (token.type === 'text' || token.type === 'paragraph') {
        parts.push(inlineHtml((token as Tokens.Text).tokens, line, warnings));
      }
    }
    return prefix + parts.join('<br>');
  });
}

export function parseDocument(source: string): DocModel {
  const { body, title } = splitFrontMatter(source.replace(/\r\n?/g, '\n'));
  const tokens = new Lexer().lex(body);
  const errors: DocFinding[] = [];
  const warnings: DocFinding[] = [];

  let name: string | null = title;
  const intro: DocFrame = { title: '', line: 0, blocks: [] };
  const frames: DocFrame[] = [];
  let current: DocFrame = intro;
  let line = 1;

  /** Consecutive paragraphs, sub-headings and quotes become one text block. */
  const addText = (html: string, at: number) => {
    const last = current.blocks.at(-1);
    if (last?.kind === 'text') last.html += html;
    else current.blocks.push({ kind: 'text', line: at, html });
    if (current === intro && intro.line === 0) intro.line = at;
  };
  const addBlock = (block: Block) => {
    current.blocks.push(block);
    if (current === intro && intro.line === 0) intro.line = block.line;
  };

  for (const token of tokens) {
    const at = line;
    line += (token.raw.match(/\n/g) ?? []).length;

    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        const text = inlineHtml(heading.tokens, at, warnings);
        if (heading.depth === 1 && name === null) {
          name = heading.text.trim();
        } else if (heading.depth <= 2) {
          current = { title: heading.text.trim(), line: at, blocks: [] };
          frames.push(current);
        } else {
          addText(`<p><strong>${text}</strong></p>`, at);
        }
        break;
      }
      case 'paragraph':
        addText(`<p>${inlineHtml((token as Tokens.Paragraph).tokens, at, warnings)}</p>`, at);
        break;
      case 'blockquote': {
        const inner = (token as Tokens.Blockquote).tokens
          .map((t) => ('tokens' in t ? inlineHtml(t.tokens as Token[], at, warnings) : ''))
          .filter(Boolean);
        for (const part of inner) addText(`<p><em>${part}</em></p>`, at);
        break;
      }
      case 'list':
        addBlock({
          kind: 'stickies',
          line: at,
          items: listItems(token as Tokens.List, at, warnings),
        });
        break;
      case 'code': {
        const code = token as Tokens.Code;
        if (isMermaid(code)) {
          addBlock({ kind: 'mermaid', line: at, codeLine: at + 1, code: code.text });
        } else {
          warnings.push({
            line: at,
            message: 'code block is not drawn; only Mermaid blocks become diagrams.',
          });
        }
        break;
      }
      case 'table':
        warnings.push({
          line: at,
          message: 'table is not drawn; write its rows as a list or as text.',
        });
        break;
      case 'html':
        warnings.push({ line: at, message: 'HTML block is not drawn.' });
        break;
      default:
        // space, hr, def: nothing to draw.
        break;
    }
  }

  if (intro.blocks.length > 0) frames.unshift({ ...intro, title: name ?? 'Overview' });
  if (name === null) {
    warnings.push({
      line: 1,
      message: 'no "# Title" heading; the board is named after its first frame.',
    });
    name = frames[0]?.title ?? 'Board';
  }
  if (frames.length === 0) {
    errors.push({
      line: 1,
      message: 'the document has no content; write one "## Heading" per frame.',
    });
  }
  for (const frame of frames) {
    if (frame.blocks.length === 0) {
      warnings.push({ line: frame.line, message: `frame "${frame.title}" is empty.` });
    }
  }
  return { name, frames, errors, warnings };
}
