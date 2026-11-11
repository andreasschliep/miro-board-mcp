/**
 * Hard limits for one spec and one build (design section 9.3).
 * They are far above a real workshop board and far below a problem.
 */
export const LIMITS = {
  /** Size of the YAML text in bytes. */
  specBytes: 100_000,
  /** Nodes after alias expansion; stops "billion laughs" alias bombs. */
  yamlNodes: 20_000,
  frames: 50,
  /** Elements after `repeat` expansion, including group items. */
  elements: 1_000,
  /** Planned Miro API calls for one build. */
  apiCalls: 600,
  /** Wall clock for one build; the build stops and returns what exists. */
  buildMs: 10 * 60 * 1000,
  /** Real builds per server process. */
  buildsPerProcess: 10,
} as const;

/** The generator keeps at least this gap between two Miro requests. */
export const MS_PER_API_CALL = 650;

export function estimateSeconds(apiCalls: number): number {
  return Math.ceil((apiCalls * MS_PER_API_CALL) / 1000);
}
