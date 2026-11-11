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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    token: optional(env.MIRO_ACCESS_TOKEN),
    teamId: optional(env.MIRO_TEAM_ID),
    allowedBoardIds: list(env.MIRO_MCP_ALLOWED_BOARD_IDS),
    allowedUrlHosts: new Set([...list(env.MIRO_MCP_ALLOWED_URL_HOSTS)].map((h) => h.toLowerCase())),
  };
}
