# miro-board-mcp: design

Status: draft for review, 11 November 2026. Design and decisions: Andreas Schliep. Drafted with Claude Code.

## 1. Goal

An agent (Claude Code, Claude Desktop) can check a board description, see what would be built, and build the Miro board, without anyone starting a script. The server is a thin MCP layer over the existing [miro-board-builder](https://github.com/andreasschliep/miro-board-builder) library.

Explainability comes before features. Every part of this design should be explainable in two sentences.

## 2. Context

| Item | Version checked on 11 Nov 2026 |
|---|---|
| MCP specification | **2026-07-28** (`modelcontextprotocol.io/specification/latest`). Stateless: no `initialize` handshake, `server/discover`, per-request `_meta` |
| TypeScript SDK | **`@modelcontextprotocol/server` 2.4.0** (v2, current stable, speaks 2026-07-28 and falls back to 2025-11-25 and older). `@modelcontextprotocol/sdk` 1.32.2 is the maintenance line and stops at 2025-11-25 |
| MCP Inspector | 2.14.0 |
| Generator | `miro-board-builder` 1.0.0, commit `4886f67`, CommonJS, Node >= 20.12 |

What the generator already provides and this server reuses: YAML parsing, JSON Schema plus semantic validation, text-fit warnings, the builder, a Miro client with throttling and retries, a dry-run transport that records every planned API call, and an in-memory frame protocol.

## 3. Architecture

```
 Human ── approves ──> Client (Claude Code / Claude Desktop)
                          │  JSON-RPC over stdio (stdout = protocol only)
                          ▼
                   miro-board-mcp (this server)
                   ├─ tools: validate_board_spec, preview_board, build_board, list_frames
                   ├─ resource: board-spec://schema
                   ├─ prompt: workshop_to_board
                   └─ guards: size limits, no !include, confirm hash, stderr logger
                          │  library calls
                          ▼
                   miro-board-builder (parser, validator, builder, Miro client)
                          │  HTTPS, Bearer token from MIRO_ACCESS_TOKEN
                          ▼
                   Miro REST API v2
```

The server holds no state between calls. Everything a later call needs (the spec, the confirm hash, the board id) is passed as an ordinary tool argument. This matches the direction of the 2026-07-28 specification.

## 4. Transport

**stdio.** The client starts the server as a local child process. One user, one machine; the Miro token never leaves the laptop. All logging goes to stderr, because stdout carries the JSON-RPC messages and any other byte there breaks the protocol.

**When Streamable HTTP would be better:** as soon as several people or remote agents share one server, for example a team server in the company network. Then the server needs real authentication (OAuth 2.1 as in the MCP authorization spec), one Miro token per user instead of one shared secret, tenant separation, TLS and Origin checks.

## 5. Tools

| Tool | Purpose | Side effect | Annotations |
|---|---|---|---|
| `validate_board_spec` | Check a YAML spec: errors with path and message, warnings and text-fit issues separately | none | `readOnlyHint`, `idempotentHint`, not `openWorldHint` |
| `preview_board` | Dry run: frames and elements in build order, counts, API calls, estimated duration, `spec_hash` | none | `readOnlyHint`, `idempotentHint`, not `openWorldHint` |
| `build_board` | Create a board (new or existing) from a spec; returns URL, counts and the frame protocol | writes to Miro | not `readOnlyHint`, not `destructiveHint` (only adds), not `idempotentHint`, `openWorldHint` |
| `list_frames` | List the frames of a board to check a result | none (reads Miro) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

Annotations are hints. The specification says clients must treat them as untrusted, so the server enforces its guards itself (section 9).

Every tool returns a short text summary plus `structuredContent` that matches a declared `outputSchema`. Input and output schemas are zod objects, which the SDK turns into JSON Schema.

### 5.1 `validate_board_spec`

- **Input:** `spec` (string, YAML, at most 100 KB).
- **Steps:** parse without `!include` → size guard → JSON Schema → semantic checks (unique ids, connector references, templates, phases) → text-fit check.
- **Output:** `{ valid, errors: [{path, message}], warnings: [{path, message}], text_fit: [{frame_id, element_index, text, deficit_px}], summary: {frames, elements} }`
- **Errors:** an invalid spec is the expected answer of this tool, so it returns `isError: false` with `valid: false` (decision D3). `isError: true` only if the spec cannot be read at all (not YAML, too large, alias bomb).

### 5.2 `preview_board`

- **Input:** `spec`.
- **Steps:** validate (as above); if valid, run the real builder against the dry-run transport and an in-memory frame protocol.
- **Output:** `{ board_name, frames: [{order, id, title, phase, elements}], totals: {frames, elements, connectors, api_calls}, estimated_seconds, spec_hash, warnings }`
- `spec_hash` is the SHA-256 of the normalized spec. It is the fingerprint of exactly what the human was shown.
- **Errors:** invalid spec → `isError: true` with the validation errors and the hint "fix the spec and call validate_board_spec".

### 5.3 `build_board`

- **Input:**
  - `spec`
  - `target`: either `{ new_board_name }` (1 to 60 characters) or `{ board_id }`
  - `dry_run`: boolean, **default `true`**
  - `confirm_hash`: string, required when `dry_run` is `false`
- **With `dry_run: true`:** no writes. Validates the spec, checks that a token is configured, and for `board_id` reads the board once to catch 401 or 404 before anyone confirms. Returns what would happen and the `spec_hash`.
- **With `dry_run: false`:** the server recomputes the hash of the given spec. If it differs from `confirm_hash`, nothing is written (`isError: true`, hint: "the spec changed after the preview; show a new preview"). Otherwise it creates the board if needed and builds.
- **Output:** `{ board_id, board_url, created_board, totals, frames: [frame protocol entries], failures: [...], aborted, retries }`
- **Repeated calls:** the tool is not idempotent. A second call with `new_board_name` creates a second board. A second call with `board_id` adds a second copy of every frame at the same position. The result text says so. There is deliberately no "clear board first" option (decision D8).
- **Errors:**
  - 401 or 403 (token or scope), or 404 (board) → stop immediately, `isError: true`, partial result plus hint.
  - 429 or 5xx after the generator's retries → that frame is marked `failed`, the build continues, and the result lists the failures.
  - Cancellation by the client → stop between frames and return the partial result.
- **Progress:** if the client sends a progress token, one progress notification per frame.

### 5.4 `list_frames`

- **Input:** `board_id`.
- **Output:** `{ board_id, count, frames: [{id, title, x, y, width, height}] }`. Frame titles and geometry only, no element content (data minimisation, see threat T4).
- **Errors:** 401, 403, 404 → `isError: true` with hint.

## 6. Domain errors and protocol errors

A **domain error** means the tool understood the request but could not do the job: an invalid spec, a board that does not exist, an expired token, a Miro 4xx. It comes back as a normal tool result with `isError: true`, a readable message and a hint on what to change, so the model can correct itself and try again. Since the 2025-11-25 specification this also covers input validation errors such as a value out of range. A **protocol error** means the request itself is broken: an unknown tool name, a request that does not match the `CallToolRequest` schema, or a crash in the server. It comes back as a JSON-RPC error. The model can rarely fix those, and the client needs to know that the conversation with the server itself has a problem.

## 7. Resource

`board-spec://schema` (`application/schema+json`): the JSON Schema of the YAML description, served from the generator package. An agent reads it before writing a spec instead of guessing field names. The tool descriptions point to it.

## 8. Prompt template

`workshop_to_board` with the arguments `topic`, `duration_minutes`, `participants` and `learning_objectives`. The template tells the agent to:

1. read `board-spec://schema`;
2. write a spec with fictional content only;
3. call `validate_board_spec` and fix it until it is valid;
4. call `preview_board` and show the frame list to the user;
5. ask for confirmation;
6. only then call `build_board` with `dry_run: false` and the `spec_hash` from the preview.

## 9. Security and operations

### 9.1 A human approves every write

1. **Client:** Claude Code and Claude Desktop ask before each tool call unless the tool is allowlisted. Recommendation: allowlist `validate_board_spec`, `preview_board` and `list_frames`, never `build_board`.
2. **Server:** `dry_run` defaults to `true`. Writing requires an explicit `false`.
3. **Server:** `confirm_hash` ties the build to the previewed spec. The agent cannot quietly change the content between preview and build.
4. **Prompt:** the template asks for confirmation before building.

Elicitation (the server asks the user directly through the client) would be a fifth layer. It depends on client support and is left for later.

### 9.2 Rate limits, retries, partial results

The generator's HTTP transport is reused unchanged: at least 650 ms between requests (about 90 per minute), up to 4 retries on 429, 5xx, timeouts and network errors, exponential backoff from 1 s, `Retry-After` honoured, 20 s timeout per request. On top of that, the server stops on fatal statuses (401, 403, 404) and on cancellation, and always returns what was created so far (needs generator change B, section 11).

### 9.3 Limits

| Limit | Value | Why |
|---|---|---|
| Spec size | 100 KB | far above a real workshop, far below a problem |
| YAML nodes after alias expansion | 20,000 | stops "billion laughs" alias bombs before the generator copies the document |
| Frames | 50 | |
| Elements after `repeat` expansion | 1,000 | |
| Planned API calls | 600 | about 6.5 minutes at 650 ms; the preview reports the estimate |
| Wall clock for one build | 10 minutes | stop with partial result |
| Builds per server process | 10 | a runaway agent cannot create boards without end |

### 9.4 Threats and how the design limits them

| # | Threat | Limitation |
|---|---|---|
| T1 | A prompt injection makes the agent build boards nobody asked for | client approval, `dry_run` default, confirm hash, builds-per-process limit |
| T2 | Huge or many boards exhaust the Miro rate limit | limits in 9.3 |
| T3 | The agent writes confidential context onto a board other people can see | new boards use Miro's private default; existing boards only when listed in `MIRO_MCP_ALLOWED_BOARD_IDS` |
| T4 | The agent reads confidential boards through `list_frames` | titles and geometry only; same allowlist; recommended: a separate Miro team with its own token |
| T5 | `!include .env` in a spec reads local files, including the token | `!include` disabled for all specs that come through MCP |
| T6 | YAML alias bomb exhausts memory | node limit before normalisation |
| T7 | `image` and `embed` place arbitrary external URLs on a board | rejected by default; allowed only for hosts in `MIRO_MCP_ALLOWED_URL_HOSTS` |
| T8 | Token leaks | token only from `MIRO_ACCESS_TOKEN`, never in results or logs; error messages contain method, path and status, not headers |
| T9 | Destructive actions | none exposed: no delete, no clear |

Configuration is environment only: `MIRO_ACCESS_TOKEN` (required for `build_board` and `list_frames`), `MIRO_TEAM_ID`, `MIRO_MCP_ALLOWED_BOARD_IDS`, `MIRO_MCP_ALLOWED_URL_HOSTS`. `.env.example` carries placeholders. Locally the server can be started through `op run`, so the token comes from 1Password and is never written to a file.

## 10. Design decisions

**D1 Transport.** Decision: stdio. Alternative: Streamable HTTP. Reason: one local user; the token stays on the laptop; no authentication layer needed (section 4).

**D2 Tool cut.** Decision: four small tools. Alternative: one `build_board` that validates, previews and builds. Reason: checking and previewing are free and can be allowlisted, writing needs approval; the agent gets feedback in small steps, and every step can be tested on its own.

**D3 Error handling.** Decision: domain errors as `isError` results with a hint, protocol errors as JSON-RPC errors; `validate_board_spec` reports an invalid spec as `valid: false` without `isError`. Alternative: everything as exceptions. Reason: the model can only correct what it sees in the result; for the validator, "invalid" is a successful answer.

**D4 Default `dry_run: true` plus confirm hash.** Decision: writing needs `dry_run: false` and the hash of the previewed spec. Alternative: a plain `confirm: true` flag. Reason: a flag can be set without a preview; the hash proves that the build matches what the human saw, and needs no server state.

**D5 Reuse instead of rewrite.** Decision: the generator is a pinned dependency (git commit), not a copy. Alternative: copy or rewrite the build logic. Reason: one source of truth for parsing, validation and Miro calls; its 55 tests keep counting; the server stays small enough to explain.

**D6 SDK line.** Decision: `@modelcontextprotocol/server` 2.4.0 (v2). Alternative: `@modelcontextprotocol/sdk` 1.32.2. Reason: v2 is the current stable line and implements the current specification; v1 is in maintenance. Compatibility with Claude Code is checked in phase 3.

**D7 Language.** Decision: TypeScript in strict mode, compiled with `tsc` to `dist/`; zod schemas at the tool boundary. Alternative: JavaScript like the generator, without a build step. Reason: TypeScript is the common base for production code; the compiler checks the server's own code, zod checks every input at runtime, and both show up in review.
**D8 No clear or delete.** Decision: the server only adds. Alternative: a `clear_first` option. Reason: a wrong agent decision then costs a cleanup, not lost work.

**D9 Data minimisation in `list_frames`.** Decision: titles and geometry only. Alternative: full item content. Reason: enough to check a build; content of client boards never enters the agent's context.

**D10 Generator changes upstream.** Decision: two small options in the generator (section 11). Alternative: work around them in the server. Reason: the workarounds would depend on private internals of the generator; the options are small, testable and useful for the CLI too.

**D11 External URLs off by default.** Decision: `image` and `embed` need an allowed host. Alternative: allow everything. Reason: a board should not show content the human did not choose; the demo does not need images.

**D12 Typed boundary to the generator.** Decision: a local declaration file `src/types/miro-board-builder.d.ts` that types only the part of the generator the server uses. Alternative: add type declarations to the generator itself. Reason: the server states exactly which generator API it depends on; the generator stays unchanged. If the generator ships its own types later, the local file is deleted.

## 11. Proposed generator changes (waiting for approval)

Rule: the generator is not changed without approval. Both changes would be new commits in the public `miro-board-builder` repository, released as 1.1.0; this server would then pin that commit.

| | Change | Why | Size |
|---|---|---|---|
| A | `new BoardParser({ allowInclude: false })` | lets callers switch off `!include` for untrusted input (T5) | about 10 lines plus tests |
| B | `builder.build(boardId, board, { signal })` checks the signal between frames, and stops on 401, 403 and 404 instead of trying every frame | cancellation and "abort with partial result" (9.2) | about 30 lines plus tests |

Without approval the server would override the parser's internal `_schema()` method for A, and wrap the transport so that it fails every further call after the first fatal error for B. That works, but it depends on private internals.

## 12. Project layout and tooling

```
miro-board-mcp/
  src/server.ts            wiring: McpServer, stdio transport, registration
  src/spec.ts              parse with limits, no !include, error shaping, spec hash
  src/miro.ts              transport and client factory, stderr logger, allowlists
  src/tools/validate.ts    src/tools/preview.ts    src/tools/build.ts    src/tools/listFrames.ts
  src/resources/schema.ts  src/prompts/workshopToBoard.ts
  src/types/miro-board-builder.d.ts   typed boundary to the generator (D12)
  test/                    node:test, mocked Miro transport
  examples/                fictional specs only
  docs/design.md
  dist/                    compiled output (not committed)
```

Dependencies: `@modelcontextprotocol/server` 2.4.0, `zod` ^4.2, `miro-board-builder` (local path during development, pinned git commit before the first push). Development: TypeScript (`strict`, `module: NodeNext`, `erasableSyntaxOnly`), `@types/node`, ESLint with typescript-eslint, Prettier, MCP Inspector through `npx`.

Build and run: `npm run build` (`tsc`) writes `dist/`; clients start `node dist/server.js`. `npm run typecheck` runs `tsc --noEmit`. Tests run the TypeScript sources directly with Node's built-in type stripping (`node --test`), so development needs Node 22.18 or later; the compiled server runs on Node 20 or later.

## 13. Test plan (phase 3)

1. Unit tests for validation and preview: valid spec, missing required fields, wrong types, empty spec, very large spec, alias bomb, `!include`.
2. `build_board` against a mocked transport: success, 401 (stops at once), 429 with retry, abort halfway (fatal error and cancellation), wrong confirm hash, default dry run.
3. MCP Inspector: all four tools, the resource and the prompt visible and callable; screenshot without token.
4. `claude mcp add`, then an end-to-end run on a test board in your own Miro account, built only after your confirmation.
5. `gitleaks detect --no-git -s .` and the portfolio denylist: zero hits.

## 14. Open questions for Andreas

1. Approve generator changes A and B? They would become public commits in `miro-board-builder`.
2. Are the limits in 9.3 right for your largest real board?
3. Existing boards only through the allowlist (safer, recommended), or any board id (more convenient)?
4. Should a second resource `board-spec://example` with a fictional example spec be added? It would help agents write a valid spec on the first try.
5. Is there a separate Miro team or developer account for the test token?

Answered: the language is TypeScript (D7, 11 November 2026).
