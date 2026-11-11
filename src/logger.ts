import type { Logger } from 'miro-board-builder';

/**
 * Logging for a stdio MCP server: stdout carries the JSON-RPC messages, so every log
 * line goes to stderr. One stray console.log would corrupt the protocol stream.
 */
export function stderrLogger(prefix = 'miro-board-mcp'): Logger {
  const write = (level: string, args: unknown[]) => {
    process.stderr.write(`${prefix} ${level}: ${args.map(String).join(' ')}\n`);
  };
  return {
    log: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

/** A logger that discards everything (dry runs, tests). */
export const silentLogger: Logger = { log() {}, warn() {}, error() {} };

/**
 * Forwards to another logger and keeps the error lines, so a tool result can tell the
 * agent which elements failed (the generator only counts them).
 */
export function collectingLogger(target: Logger): Logger & { readonly errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    log: (...args) => target.log(...args),
    warn: (...args) => target.warn(...args),
    error: (...args) => {
      errors.push(args.map(String).join(' ').trim());
      target.error(...args);
    },
  };
}
