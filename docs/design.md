# miro-board-mcp: design

Status: draft for review, 11 November 2026. Design and decisions: Andreas Schliep. Drafted with Claude Code.

## 1. Goal

An agent (Claude Code, Claude Desktop) can check a board description, see what would be built, and build the Miro board, without anyone starting a script. The server is a thin MCP layer over the existing [miro-board-builder](https://github.com/andreasschliep/miro-board-builder) library.

Explainability comes before features. Every part of this design should be explainable in two sentences.

## 2. Context

| Item              | Version checked on 11 Nov 2026                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP specification | **2026-07-28** (`modelcontextprotocol.io/specification/latest`). Stateless: no `initialize` handshake, `server/discover`, per-request `_meta`                                                               |
| TypeScript SDK    | **`@modelcontextprotocol/server` 2.4.0** (v2, current stable, speaks 2026-07-28 and falls back to 2025-11-25 and older). `@modelcontextprotocol/sdk` 1.32.2 is the maintenance line and stops at 2025-11-25 |
| MCP Inspector     | 2.14.0                                                                                                                                                                                                      |
| Generator         | `miro-board-builder` 1.0.0, commit `4886f67`, CommonJS, Node >= 20.12                                                                                                                                       |

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

The server holds no state between calls. Everything a later call needs (the spec, the confirm hash, the board id) is passed as an ordinary tool argument. This matches the direction of the 2026-07-28 specification. One deliberate exception: the process remembers the ids of the boards it created, so it may list and extend them, and it counts its builds (limit in 9.3).

## 4. Transport

**stdio.** The client starts the server as a local child process. One user, one machine; the Miro token never leaves the laptop. All logging goes to stderr, because stdout carries the JSON-RPC messages and any other byte there breaks the protocol.

**When Streamable HTTP would be better:** as soon as several people or remote agents share one server, for example a team server in the company network. Then the server needs real authentication (OAuth 2.1 as in the MCP authorization spec), one Miro token per user instead of one shared secret, tenant separation, TLS and Origin checks.

## 5. Tools

| Tool                  | Purpose                                                                                         | Side effect       | Annotations                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `validate_board_spec` | Check a YAML spec: errors with path and message, warnings and text-fit issues separately        | none              | `readOnlyHint`, `idempotentHint`, not `openWorldHint`                                        |
| `preview_board`       | Dry run: frames and elements in build order, counts, API calls, estimated duration, `spec_hash` | none              | `readOnlyHint`, `idempotentHint`, not `openWorldHint`                                        |
| `build_board`         | Create a board (new or existing) from a spec; returns URL, counts and the frame protocol        | writes to Miro    | not `readOnlyHint`, not `destructiveHint` (only adds), not `idempotentHint`, `openWorldHint` |
| `list_frames`         | List the frames of a board to check a result                                                    | none (reads Miro) | `readOnlyHint`, `idempotentHint`, `openWorldHint`                                            |

Annotations are hints. The specification says clients must treat them as untrusted, so the server enforces its guards itself (section 9).

Every tool returns a short text summary plus `structuredContent` that matches a declared `outputSchema`. Input and output schemas are zod objects, which the SDK turns into JSON Schema.

### 5.1 `validate_board_spec`

- **Input:** `spec` (string, YAML, at most 100 KB).
- **Steps:** parse without `!include` → size guard → JSON Schema → semantic checks (unique ids, connector references, templates, phases) → text-fit check.
- **Output:** `{ valid, errors: [{path, message}], warnings: [{path, message}], text_fit: [{frame_id, element_index, text, deficit_px}], layout: [{frame_id, path, message}], summary: {frames, spec_elements} }`
- **Layout warnings** (`src/layout.ts`, added after the first end-to-end run): an element that extends beyond its frame, a line whose start or end lies outside the frame, or an element on the 60-unit title bar. They are warnings, not errors; the tool text and the prompt template tell the agent to fix them before building.
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

- **Input:** `board_id`. Allowed: boards on the allowlist and boards this server process created.
- **Output:** `{ board_id, board_url, count, truncated, frames: [{id, title, x, y, width, height}] }`. Frame titles and geometry only, no element content (data minimisation, see threat T4). At most 10 pages of 50 items.
- **Errors:** 401, 403, 404 → `isError: true` with hint.

## 6. Domain errors and protocol errors

A **domain error** means the tool understood the request but could not do the job: an invalid spec, a board that does not exist, an expired token, a Miro 4xx. It comes back as a normal tool result with `isError: true`, a readable message and a hint on what to change, so the model can correct itself and try again. Since the 2025-11-25 specification this also covers input validation errors such as a value out of range. A **protocol error** means the request itself is broken: an unknown tool name, or a request that does not match the `CallToolRequest` schema. It comes back as a JSON-RPC error. The model can rarely fix those, and the client needs to know that the conversation with the server itself has a problem.

As implemented with SDK v2: the SDK checks every call against the tool's zod input schema and returns a failed check as an `isError` result. An unexpected exception inside a tool handler also becomes an `isError` result with the exception message. The server therefore catches every expected failure itself and adds a hint; the protocol test (`test/server.test.ts`) checks that an unknown tool is rejected as a protocol error.

Finding from the MCP Inspector (phase 3): the Inspector validates `structuredContent` against the tool's `outputSchema` even when `isError` is true; the server SDK does not. Domain errors therefore carry their details in the text and no `structuredContent`. The only exception is a partial build result of `build_board`, which has exactly the shape of a successful result (`note` carries the hint), so every client accepts it.

## 7. Resource

`board-spec://schema` (`application/schema+json`): the JSON Schema of the YAML description, served from the generator package. An agent reads it before writing a spec instead of guessing field names. The tool descriptions point to it.

`board-spec://example` (`application/yaml`): a complete, valid spec for a fictional 45-minute workshop (`examples/code-review-basics.yaml`), showing phases, `repeat`, templates and connectors.

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

| Limit                             | Value      | Why                                                                         |
| --------------------------------- | ---------- | --------------------------------------------------------------------------- |
| Spec size                         | 100 KB     | far above a real workshop, far below a problem                              |
| YAML nodes after alias expansion  | 20,000     | stops "billion laughs" alias bombs before the generator copies the document |
| Frames                            | 50         |                                                                             |
| Elements after `repeat` expansion | 1,000      |                                                                             |
| Planned API calls                 | 600        | about 6.5 minutes at 650 ms; the preview reports the estimate               |
| Wall clock for one build          | 10 minutes | stop with partial result                                                    |
| Builds per server process         | 10         | a runaway agent cannot create boards without end                            |

### 9.4 Threats and how the design limits them

| #   | Threat                                                                  | Limitation                                                                                                                         |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| T1  | A prompt injection makes the agent build boards nobody asked for        | client approval, `dry_run` default, confirm hash, builds-per-process limit                                                         |
| T2  | Huge or many boards exhaust the Miro rate limit                         | limits in 9.3                                                                                                                      |
| T3  | The agent writes confidential context onto a board other people can see | new boards use Miro's private default; existing boards only when listed in `MIRO_MCP_ALLOWED_BOARD_IDS` or created by this process |
| T4  | The agent reads confidential boards through `list_frames`               | titles and geometry only; same allowlist; recommended: a separate Miro team with its own token                                     |
| T5  | `!include .env` in a spec reads local files, including the token        | `!include` disabled for all specs that come through MCP                                                                            |
| T6  | YAML alias bomb exhausts memory                                         | node limit before normalisation                                                                                                    |
| T7  | `image` and `embed` place arbitrary external URLs on a board            | rejected by default; allowed only for hosts in `MIRO_MCP_ALLOWED_URL_HOSTS`                                                        |
| T8  | Token leaks                                                             | token only from `MIRO_ACCESS_TOKEN`, never in results or logs; error messages contain method, path and status, not headers         |
| T9  | Destructive actions                                                     | none exposed: no delete, no clear                                                                                                  |

Configuration is environment only: `MIRO_ACCESS_TOKEN` (required for `build_board` and `list_frames`), `MIRO_TEAM_ID`, `MIRO_MCP_ALLOWED_BOARD_IDS`, `MIRO_MCP_ALLOWED_URL_HOSTS`. `.env.example` carries placeholders. Locally the server can be started through `op run`, so the token comes from 1Password and is never written to a file.

## 10. Design decisions

**D1 Transport.** Decision: stdio. Alternative: Streamable HTTP. Reason: one local user; the token stays on the laptop; no authentication layer needed (section 4).

**D2 Tool cut.** Decision: four small tools. Alternative: one `build_board` that validates, previews and builds. Reason: checking and previewing are free and can be allowlisted, writing needs approval; the agent gets feedback in small steps, and every step can be tested on its own.

**D3 Error handling.** Decision: domain errors as `isError` results with a hint, protocol errors as JSON-RPC errors; `validate_board_spec` reports an invalid spec as `valid: false` without `isError`. Alternative: everything as exceptions. Reason: the model can only correct what it sees in the result; for the validator, "invalid" is a successful answer.

**D4 Default `dry_run: true` plus confirm hash.** Decision: writing needs `dry_run: false` and the hash of the previewed spec. Alternative: a plain `confirm: true` flag. Reason: a flag can be set without a preview; the hash proves that the build matches what the human saw, and needs no server state.

**D5 Reuse instead of rewrite.** Decision: the generator is a pinned dependency (git commit), not a copy. Alternative: copy or rewrite the build logic. Reason: one source of truth for parsing, validation and Miro calls; its 55 tests keep counting; the server stays small enough to explain.

**D6 SDK line.** Decision: `@modelcontextprotocol/server` 2.4.0 (v2). Alternative: `@modelcontextprotocol/sdk` 1.32.2. Reason: v2 is the current stable line and implements the current specification; v1 is in maintenance. Compatibility with Claude Code is checked in phase 3.

**D7 Language.** Decision: TypeScript in strict mode, compiled with `tsc` to `dist/`; zod schemas at the tool boundary. Alternative: JavaScript like the generator, without a build step. Reason: TypeScript is the common base for production code; the compiler checks the server's own code, zod checks every input at runtime, and both show up in review. Version: TypeScript 6.0, because typescript-eslint does not support 7.x yet.
**D8 No clear or delete.** Decision: the server only adds. Alternative: a `clear_first` option. Reason: a wrong agent decision then costs a cleanup, not lost work.

**D9 Data minimisation in `list_frames`.** Decision: titles and geometry only. Alternative: full item content. Reason: enough to check a build; content of client boards never enters the agent's context.

**D10 Generator changes upstream.** Decision: two small options in the generator (section 11). Alternative: work around them in the server. Reason: the workarounds would depend on private internals of the generator; the options are small, testable and useful for the CLI too.

**D11 External URLs off by default.** Decision: `image` and `embed` need an allowed host. Alternative: allow everything. Reason: a board should not show content the human did not choose; the demo does not need images.

**D13 Layout problems are warnings.** Decision: overlapping frames, and elements outside their frame or on the title bar, are reported as layout warnings; the spec stays valid. Alternative: treat them as errors. Reason: an overhang can be intended, but a line ending far outside the frame or two frames on top of each other are almost always a misunderstanding; the warning names the cause (toX/toY are distances, frameSpacing/rowSpacing are distances between centres) so the agent fixes it before the human sees the preview.

**D14 Elements stay unparented.** Decision: the server keeps the generator default `style.parentElements: false`. Alternative: make every element a child of its frame. Reason: the parented path has not been tried in a live build through this server, embeds cannot be parented, and Miro then measures child positions from the frame's top-left corner; switching the default needs a live build first. Cost: moving a frame in Miro leaves its elements behind, so a misplaced frame cannot be repaired by hand. The schema says so, and D13 catches overlapping frames before the build.

**D12 Typed boundary to the generator.** Decision: a local declaration file `src/types/miro-board-builder.d.ts` that types only the part of the generator the server uses. Alternative: add type declarations to the generator itself. Reason: the server states exactly which generator API it depends on; the generator stays unchanged. If the generator ships its own types later, the local file is deleted.

## 11. Generator changes (approved 11 November 2026)

Rule: the generator is not changed without approval. Both changes are implemented as version 1.1.0 of `miro-board-builder`; with Andreas's approval they were published to its `main` branch on 13 November 2026 (commit `983ba03`, including the schema descriptions below). This server pins that commit as a git submodule in `vendor/miro-board-builder` and depends on it with `file:vendor/miro-board-builder`, because npm 12 refuses git and tarball dependencies.

|     | Change                                                                                                                                    | Why                                                         | Size                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| A   | `new BoardParser({ allowInclude: false })`                                                                                                | lets callers switch off `!include` for untrusted input (T5) | about 10 lines plus tests |
| B   | `builder.build(boardId, board, { signal })` checks the signal between frames, and stops on 401, 403 and 404 instead of trying every frame | cancellation and "abort with partial result" (9.2)          | about 30 lines plus tests |

Without approval the server would override the parser's internal `_schema()` method for A, and wrap the transport so that it fails every further call after the first fatal error for B. That works, but it depends on private internals.

Approved with the phase 3 fixes on 12 November 2026, also on `mcp-support`: descriptions in `schema/board.schema.json` for element `x`, `y`, `toX`, `toY`, for `layout.startX`, `frameSpacing`, `rowSpacing`, for frame `row`, `col`, `x`, `y`, and for what `style.parentElements: false` means. Descriptions only; no behaviour changes.

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

Build and run: `npm run build` (`tsc`) writes `dist/`; clients start `node dist/server.js`. `npm run typecheck` runs `tsc --noEmit`. Tests run the TypeScript sources directly with Node's built-in type stripping (`node --test`); Node 22.18 or later is required.

## 13. Test plan (phase 3)

1. Unit tests for validation and preview: valid spec, missing required fields, wrong types, empty spec, very large spec, alias bomb, `!include`.
2. `build_board` against a mocked transport: success, 401 (stops at once), 429 with retry, abort halfway (fatal error and cancellation), wrong confirm hash, default dry run.
3. MCP Inspector: all four tools, the resource and the prompt visible and callable; screenshot without token.
4. `claude mcp add`, then an end-to-end run on a test board in your own Miro account, built only after your confirmation.
5. `gitleaks detect --no-git -s .` and the portfolio denylist: zero hits.

### Findings from phase 3

- **MCP Inspector:** structuredContent is validated on error results by some clients (section 6), and type arrays such as `["string","null"]` are less portable; both fixed.
- **First end-to-end run (12 November 2026):** the agent followed the intended order (resources, validate, preview, question, build after the user's yes) and built 11 frames without errors. But it read `toX`/`toY` as absolute end points, so the axes of three map frames came out diagonal and partly outside their frames. Nothing in the schema said otherwise and no check caught it. Fixes: descriptions for `x`, `y`, `toX`, `toY` in the generator schema, a line in the example spec, and layout warnings in `validate_board_spec` and `preview_board`. The spec from that run now produces 9 layout warnings that name the cause.
- **Prompt template as a slash command:** Claude Code asks for every argument; `participants` and `learning_objectives` are now optional.
- **Second end-to-end run (12 November 2026, a 46 KB spec with four Wardley maps):** validation, preview and build worked as designed: 4 frames, 279 elements, 76 connectors, 360 API calls (preview: 359, plus creating the board), 0 errors, 0 retries, 269 s against an estimate of 234 s. The layout warnings from the first run kept the lines inside their frames. But the agent read `layout.frameSpacing` and `rowSpacing` as gaps; with 300 for 3000 x 1800 frames, all four frames landed on top of each other. Because elements are not parented (D14), moving the frames in Miro does not help. Fixes: schema descriptions for the frame layout, a layout warning for overlapping frames (the spec from that run now produces 6), and `elapsed_seconds` in the result of `build_board`.
- **Smaller findings from the second run, not fixed yet:** a duplicate `ref` is reported with the path `/` instead of the element; unknown values for connector `shape`, `startCap`/`endCap` and line `color` pass silently because the schema has no enums for them; a text-fit warning does not say whether width or height is short; the full spec is sent again with every call.

## 14. Decisions taken and open points

Answered on 11 November 2026:

- Language: TypeScript (D7).
- Generator changes A and B: approved; published as 1.1.0 on 13 November 2026 after a separate approval.
- Limits: as in 9.3.
- Existing boards: only through the allowlist (or created by this process).
- Example resource: yes, `board-spec://example`.

Open:

- A separate Miro team or developer account for the test token (phase 3).
- A live build with `style.parentElements: true` before deciding whether to change D14.

## 15. Markdown and Mermaid as input (approved and implemented, 13 November 2026)

**Status: implemented on 13 November 2026 with the decisions in 15.8; the end-to-end run is still open.**

### 15.1 Why

Andreas wants Markdown and Mermaid as the source of a board; the YAML spec of the generator becomes an implementation detail of this server. There is a second reason: both end-to-end failures came from coordinates the agent wrote itself (`toX`/`toY` in run 1, `frameSpacing`/`rowSpacing` in run 2). If the server computes every position, these error classes disappear; the layout warnings (D13) stay as a safety net.

### 15.2 Document format

A board is one Markdown document:

| Markdown                                                | On the board                                        |
| ------------------------------------------------------- | --------------------------------------------------- |
| `# Title` (first level-1 heading)                       | board name                                          |
| `## Heading`                                            | one frame, in document order                        |
| paragraphs under a frame heading                        | a text block at the top of the frame                |
| bullet list                                             | sticky notes in a grid                              |
| fenced block ` ```mermaid ` with `wardley-beta`         | a Wardley map that fills the frame                  |
| fenced block ` ```mermaid ` with `flowchart` or `graph` | shapes and connectors, laid out automatically       |
| anything else (tables, images, other diagram types)     | not drawn; validation names it with its line number |

The server places frames in a row with a fixed gap and sizes each frame from its content. The agent writes no coordinates, no `ref`s and no spacing. A document that renders in a Markdown viewer or on GitHub is also the board description; the Wardley document from run 2 (`wardley-beta` blocks with pipelines as bands) already has this shape.

### 15.3 Mermaid support

- **`wardley-beta`**, parsed with the official `@mermaid-js/parser` 2.0.1 (Langium grammar, no DOM; checked in Node on 13 November 2026). Mapping: map area with axes and the four evolution stages; anchors and components as circles with labels at `[visibility, evolution]`; links as connectors; `evolve` as a red dashed arrow to a ghost component; pipelines as Mermaid draws them: the parts on the parent's line inside a box, the parent moved to the top centre of the box, a link from a part to its own parent not drawn (this is how bands and groups are written, since the grammar has no group statement); notes as text; numbered annotations. Colours from the block's front matter (`themeVariables.wardley`), as far as they apply.
- **`flowchart` / `graph`** (TD, LR, BT, RL), parsed with the official `mermaid` (12.2.0 pinned; 12.3.0 was less than two weeks old). In Node it needs a DOM for its sanitiser; with a jsdom window it returned shapes, labels, dotted edges, edge labels, subgraphs and the direction (checked on 13 November 2026). Layout with `@dagrejs/dagre` 3.1.3 (pure JavaScript). Shapes: rectangle, rounded, stadium, diamond, circle; anything else becomes a rectangle with a warning. A subgraph becomes a titled box around its nodes. `classDef` fill and stroke colours are used.
- Other diagram types are a validation error that lists the supported ones.

### 15.4 Architecture

```text
Markdown document
  -> src/document/: Markdown lexer (marked 18), one frame per "##"
     -> per block: text | stickies | wardley (@mermaid-js/parser) | flowchart (mermaid + jsdom, dagre)
  -> board object in the generator's format (internal, never shown to the agent)
  -> unchanged path: validateBoard, text fit, layout check, plan (DryRunTransport), hash, BoardBuilder
```

- The generator does not change.
- `confirm_hash` stays the hash of the canonical generated board, so the confirmation binds to exactly what will be drawn.
- Findings point to Markdown line numbers (frame heading, Mermaid block, line of the Mermaid parse error), not to JSON paths.
- `preview_board` also lists the position and size of every frame (finding from run 2).

### 15.5 Interface changes

| Today                                         | Proposal                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `validate_board_spec(spec)`                   | `validate_board(document)`                                        |
| `preview_board(spec)`, `build_board(spec, …)` | same tools, `document` (or `spec`)                                |
| resource `board-spec://schema`                | `board-doc://guide`: format, supported Mermaid, one small example |
| resource `board-spec://example` (YAML)        | `board-doc://example` (Markdown)                                  |
| prompt `workshop_to_board`: write YAML        | write Markdown; no coordinates                                    |

Decided: the YAML spec stays as a second, optional parameter `spec` for exact positions; its schema and example stay as resources marked "advanced". A call with both `document` and `spec` is refused.

### 15.6 What gets simpler, what is lost

- Simpler: no coordinates, no frame layout, no connector refs; the agent needs no schema, only the short guide; the document is readable on its own.
- Lost: exact control over positions and colours of single elements. Layout quality depends on dagre and on the Wardley mapping.
- Cost: `mermaid` plus `jsdom` add about 130 MB to `node_modules` (the Wardley parser alone is 11 MB). Alternative for flowcharts: an own parser for a documented subset, small but with a grammar that can drift from Mermaid's.

### 15.7 Plan

1. Markdown frames, text, stickies and `wardley-beta`, with tests (a synthetic map with pipelines as bands, line numbers in errors, hash stability).
2. `flowchart` with dagre, with tests.
3. Tools, resources, prompt and design sections 5, 7, 8 updated; old YAML tests converted.
4. End-to-end run: build the Wardley document from run 2 as a new board after Andreas's yes.

### 15.8 Decisions (Andreas, 13 November 2026)

**D15 A board is a Markdown document.** Decision: `document` (Markdown with Mermaid) is the normal input; the server computes every position. Alternative: keep YAML as the input. Reason: the source stays readable on its own, and the coordinate errors of both end-to-end runs cannot occur.

**D16 Flowcharts with the official Mermaid parser.** Decision: `mermaid` with a jsdom window, layout with dagre. Alternative: an own parser for a subset. Reason: the same grammar as every Mermaid renderer; the cost is about 130 MB of dependencies, loaded only when a flowchart appears.

**D17 Lists become sticky notes.** Decision: one sticky per list item. Alternative: a text block. Reason: on a workshop board, a list is usually material to move around.

**D18 YAML stays as an option.** Decision: a second parameter `spec` for exact positions. Alternative: drop it from the tools. Reason: some boards need exact layout; the agent is told to use it only when the user asks for it.

Scope before 17 November: Wardley maps and flowcharts, then one end-to-end run.

### 15.9 Implementation notes

- `src/document/markdown.ts` (marked lexer), `wardley.ts`, `flowchart.ts`, `compose.ts` (frame layout), `check.ts` (findings to lines); `src/source.ts` picks document or spec.
- New dependencies, pinned, each at least two weeks old on 13 November 2026: `marked` 18.1.2, `@mermaid-js/parser` 2.0.1, `mermaid` 12.2.0, `jsdom` 30.1.3, `@dagrejs/dagre` 3.1.3, `js-yaml` 5.5.0 (front matter).
- Mermaid keeps one database per diagram type, so flowchart parsing runs one at a time.
- Checked with the Wardley document from run 2 (three `wardley-beta` maps with pipelines as bands): valid, no warnings, 5 frames, 305 API calls; a local SVG rendering of the composed frames showed the bands on their lines and no element outside its frame.

### 15.10 Third end-to-end run and fault test (13 November 2026)

**Run:** an agent wrote a fictional 60-minute workshop document with text, sticky notes, a flowchart with a subgraph and a decision, and a Wardley map with a pipeline, using only the guide and the example. `validate_board` found it valid on the first call, with no warnings; preview: 6 frames, 75 elements, 18 connectors, 99 API calls, 65 s estimated. Two counts confused the agent: every frame counted one element more than its content (the title bar), and `validate_board`'s count (elements and connectors, no title bars) did not match the preview's (elements with title bars, connectors apart). Both texts now say so.

**Fault test:** the same agent sent a document with 20 deliberate mistakes. 13 were reported, 4 of them with messages that did not help (raw parser tokens, a later line than the cause, an internal path); 7 passed silently. Fixes, each with a test:

| Mistake                                             | Before                                                            | Now                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| unclosed `[` in a flowchart line                    | parser error two lines later                                      | error on the line itself, "opens [ but does not close it"               |
| unquoted Wardley name with an umlaut                | "found `nge`"                                                     | the lexer's error and "needs double quotes, e.g. component \"Zugänge\"" |
| code block never closed                             | parser error, later frames silently lost                          | error on the opening line: everything after it was read as code         |
| map label outside the frame                         | start of the block, internal path                                 | line of the statement, `line N` as path, element named with its text    |
| Wardley value above 1                               | silently clamped                                                  | error with the line, drawing continues so other findings still appear   |
| `fill:green`, `click`                               | ignored silently                                                  | warning with the line                                                   |
| `http://` link                                      | link silently dropped                                             | warning: only the text is kept                                          |
| duplicate frame title                               | silent second id                                                  | warning naming both lines                                               |
| sticky note over 140, node label over 80 characters | nothing (the text-fit check only covers shapes with a fixed size) | warning with the line                                                   |

Also: findings are sorted by line; a document with only a title gives one error with a line instead of an additional schema error; `evolve` on a pipeline part is not drawn and gets a warning, because Mermaid does not draw it either (found while rendering a map with Mermaid 12.2).

Not tested yet: `build_board` with `dry_run: false` and a wrong `confirm_hash` against Miro (covered by unit tests only).
