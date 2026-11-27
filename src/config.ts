import { isAbsolute, join } from 'node:path';
import { LOGO_ENV, type LogoSource, type SlideLogos } from './document/theme.ts';

/**
 * Server configuration. Environment variables only; the token never leaves this object
 * except as the Authorization header the generator's transport sends to Miro.
 */
export interface ServerConfig {
  /** MIRO_ACCESS_TOKEN. Never log it, never put it into a result. */
  readonly token: string | undefined;
  readonly teamId: string | undefined;
  /** Existing boards the server may read and write (MIRO_MCP_ALLOWED_BOARD_IDS). */
  readonly allowedBoardIds: ReadonlySet<string>;
  /** Hosts allowed in image and embed URLs (MIRO_MCP_ALLOWED_URL_HOSTS). */
  readonly allowedUrlHosts: ReadonlySet<string>;
  /** Footer logos of theme slides (MIRO_SLIDE_LOGO_LEFT, MIRO_SLIDE_LOGO_RIGHT). */
  readonly slideLogos: SlideLogos;
}

function list(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A logo is an absolute path (or ~/...) to a local file, or an https URL. */
function logoSource(env: NodeJS.ProcessEnv, name: string): LogoSource | undefined {
  const value = optional(env[name]);
  if (value === undefined) return undefined;
  if (/^https:\/\//i.test(value)) return { env: name, kind: 'url', value };
  if (/^[a-z]+:\/\//i.test(value)) {
    return { env: name, kind: 'invalid', value, reason: 'only https URLs are allowed' };
  }
  const home = env.HOME;
  const path = value.startsWith('~/') && home ? join(home, value.slice(2)) : value;
  if (!isAbsolute(path)) {
    return { env: name, kind: 'invalid', value, reason: 'use an absolute path or an https URL' };
  }
  return { env: name, kind: 'file', value: path };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    token: optional(env.MIRO_ACCESS_TOKEN),
    teamId: optional(env.MIRO_TEAM_ID),
    allowedBoardIds: list(env.MIRO_MCP_ALLOWED_BOARD_IDS),
    allowedUrlHosts: new Set([...list(env.MIRO_MCP_ALLOWED_URL_HOSTS)].map((h) => h.toLowerCase())),
    slideLogos: Object.fromEntries(
      (['left', 'right'] as const).flatMap((side) => {
        const source = logoSource(env, LOGO_ENV[side]);
        return source ? [[side, source]] : [];
      }),
    ),
  };
}

/** What the checks need from the configuration (src/spec.ts SpecPolicy). */
export function policyFrom(config: ServerConfig): {
  allowedUrlHosts: ReadonlySet<string>;
  slideLogos: SlideLogos;
} {
  return { allowedUrlHosts: config.allowedUrlHosts, slideLogos: config.slideLogos };
}
