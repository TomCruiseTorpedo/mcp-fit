# ADR-G: ACP eval harness (`AcpHarness`)

- Status: accepted
- Date: 2026-07-05
- Owners: mcp-fit maintainers

## Context

ADR-B reserved a v1.1 seam: "a single ACP adapter behind the same Harness
interface" instead of per-vendor SDKs. That bet has matured — the Agent Client
Protocol (Zed-origin, now community-governed, JetBrains co-developing) has an
official registry of 25+ coding agents (Claude Code, Codex CLI, Copilot CLI,
Gemini CLI, OpenCode, …), all driveable as subprocesses over one JSON-RPC/stdio
protocol. One `AcpHarness` makes every registry agent a pluggable eval driver
for mcp-fit's dynamic eval, enabling cross-harness scorecards ("does this MCP
server confuse Codex more than Claude?").

Spec-depth verification (2026-07-05, against the live protocol docs and the
shipped SDK types) pinned the load-bearing facts:

- `session/new` takes a REQUIRED `mcpServers` array; the stdio variant is
  `{name, command, args, env: EnvVariable[]}` — so the CLIENT hands the agent
  the target MCP server. Caveat: agents "SHOULD connect to all MCP servers
  specified by the Client" — SHOULD, not MUST.
- Tool activity surfaces as `tool_call` / `tool_call_update` session updates
  folded by `toolCallId`; every field except `toolCallId` is optional —
  `rawInput`/`rawOutput` presence is agent-dependent.
- `usage_update` reports context occupancy (`used`/`size` of the context
  window), NOT cumulative token cost.
- TS SDK: `@agentclientprotocol/sdk@1.1.0` (builder API `client()`,
  `ndJsonStream` for stdio, zero runtime deps, one REQUIRED peer `zod`).

## Decision

### G1 — One new file; the sync-manifest files stay untouched

`AcpHarness implements Harness` lives in `src/eval/acp-harness.ts`; the pinned
agent registry lives in `src/eval/acp-agents.ts`. No ACP types leak outside
these two files (the same containment rule ClaudeHarness follows for Anthropic
types). `src/eval/harness.ts`, `src/models.ts`, `src/fix/rewriter.ts`, and
`src/score/rubric.ts` are vendored byte-identically into gatewarden
(`scripts/score-engine.sha256`) and are NOT modified.

### G2 — Observe, don't intercept

ClaudeHarness intercepts execution via `sandbox.callTool()`. An ACP agent
executes tools itself against client-supplied MCP servers, so the trust
topology inverts:

- The target MCP server's stdio spec is passed in `session/new mcpServers`
  (constructor option, not derived from the sandbox).
- The harness OBSERVES tool activity via `tool_call`/`tool_call_update`
  updates and reconstructs the transcript by folding on `toolCallId`.
- `sandbox.listTools()` supplies the target-tool universe (for attribution
  and no-contact detection); `sandbox.callTool()` is never invoked.
- The client declares no fs/terminal capabilities at `initialize`, and the
  session `cwd` is a per-run scratch directory.

**Security note (trust-boundary difference, spec §Dynamic Eval):** the
in-process Sandbox cannot enforce its deny-list on an ACP agent's own built-in
tools. Containment relies on capability declaration + scratch cwd + the
operator's choice of agent. This is weaker than the ClaudeHarness sandbox and
is documented, not hidden — eval runs with AcpHarness trust the driven agent
binary.

### G3 — Contract change: `tokenCost` nullable, `degraded` flag (schema 1.1.0)

- `TaskTrace.tokenCost: number | null` — null means "not measured", never
  "zero". ACP provides no cumulative token cost (`usage_update` is context
  occupancy — using its final `used` value would misreport the semantics).
- `TaskTrace.degraded?: boolean` — true when the harness could not fully
  observe the run: any folded tool call missing `rawInput`, or tool activity
  present but none attributable to the target server. Degraded traces must
  not feed before/after scorecard claims.
- `EVALS_SCHEMA_VERSION` 1.0.0 → 1.1.0; `schemas/evals.schema.json` updated
  (`tokenCost` nullable, `degraded` optional).
- Known wart: `src/score/rubric.ts` interpolates `Token cost: ${trace.tokenCost}`
  into the judge prompt — an ACP trace renders "Token cost: null". Harmless to
  the judge; fixing the wording requires a mirrored gatewarden change
  (sync manifest), deferred to the next joint sync pass.

### G4 — Tool attribution ladder (deterministic)

`chosenTools` must carry MCP tool names for `expectedTools` pass/fail, but ACP
`tool_call.title` is human-readable and only sometimes the tool name. Ladder,
applied per folded call against the sandbox tool-name universe:

1. exact: `title` equals a target tool name → that name;
2. word match: exactly one target tool name appears as a whole word in the
   title (case-insensitive, `_`/`-` normalised) → that name;
3. otherwise unattributed: excluded from `chosenTools`, counted as activity.

No-contact semantics: zero tool calls at all → `pass: false`,
`degraded: true` (the agent never attempted the toolset — SHOULD-strength
`mcpServers` connection means this is detectable but not preventable). Tool
calls present but none attributed → `degraded: true` (cannot certify contact).

### G5 — Permissions: auto-grant, least-privilege option

Headless evals cannot prompt a human. `session/request_permission` is answered
by preferring the `allow_once` option, falling back to the first allow-kind
option, else cancelling. Every auto-grant is logged to stderr. (Recording
grants inside TaskTrace is deferred — it would be another contract change;
revisit when eval-mode lands in the CLI.)

### G6 — Pinned agent registry as typed data

`src/eval/acp-agents.ts` exports `ACP_AGENTS`: registry entries are data
(`{id, command, args, env?}`), not code — adding an agent is a config addition.
v1 pins two reference agents:

- `claude-agent-acp` — `npx --yes @agentclientprotocol/claude-agent-acp@0.55`
- `gemini` — `gemini --experimental-acp` (requires `GEMINI_API_KEY` in the
  environment for headless use — the CLI's interactive login hangs headless).

A JSON registry file + CLI flag ships with eval-mode CLI wiring (deferred with
it).

### G7 — Failure semantics

Protocol/spawn failures and timeouts (default 120 s) throw `AcpHarnessError`
after SIGTERM→SIGKILL on the subprocess — matching ClaudeHarness, which throws
on API errors. The agent's stderr is passed through to the operator's stderr.

### G8 — Agent isolation, package subjects, negative and claims tasks (2026-10-14, schema 1.2.0)

Status: accepted. Motivation: a cross-vendor scorecard is only comparable if
each agent runs as a fresh install would. Before G8 the agent was spawned with
`{ ...process.env, ...agent.env }`, so `claude-agent-acp` loaded the
operator's own CLAUDE.md, skills, hooks and MCP servers, and a score described
that operator's setup. The method is adapted from the agent-evaluation lane
of `morluto/rea` (MIT); no code was copied.

- **Isolation, default `clean`.** The agent gets a disposable HOME
  (`createDisposableWorkspace`, the helper target servers already use), XDG
  directories inside it, and an allowlisted environment: the MCP SDK's own
  stdio allowlist minus HOME, plus LANG, LC_ALL and TMPDIR, plus the agent's
  declared auth variables, plus `agent.env`. `npm_config_cache` keeps
  pointing at the operator's npm cache so `npx` agents do not re-download per
  run; it holds tarballs, not configuration, and `~/.npmrc` stays out.
  `isolation: 'inherit'` restores the old behaviour, and every trace records
  which one applied. This isolates CONFIGURATION, not the process: absolute
  paths still resolve, as for target servers. It is not a sandbox.
- **Declared auth.** `AcpAgentSpec.auth` names environment variables and
  HOME-relative files (copied with mode 0600). With `required: true`, a clean
  run with none of them fails before spawning, because a logged-out agent
  would otherwise surface as a no-contact trace. Measured on macOS
  2026-10-14: the Claude login lives in the Keychain, and a clean HOME leaves
  `claude` "Not logged in", so `claude-agent-acp` declares
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`.
  An end-to-end run of `claude-agent-acp` with the OAuth token has not been
  done yet.
- **Package subjects.** `targetFromPackage(pkg, version)` launches a published
  server the way its users do, `npx --yes <pkg>@<version>`, and accepts exact
  versions only. The trace's `subject` records the package and version, or
  `source: "command"` for an operator-supplied command line.
- **Task fields live in `AcpEvalTask`, not `EvalTask`.** `src/eval/harness.ts`
  is vendored byte-identically into gatewarden, so the new fields extend
  `EvalTask` inside `acp-harness.ts`. ClaudeHarness is unaffected; it calls
  the API directly and has no client configuration to isolate.
- **Negative scenario.** With `expectNoToolCalls`, zero calls pass and are not
  degraded, and any call fails. Zero calls alone cannot tell "correctly
  declined" from "never saw the server" (G4: the connection is SHOULD-strength),
  so `expectReplyMatches` adds positive evidence, for example a clarifying
  question.
- **Claims manifest.** `claims` lists `{id, question, expected}`. The prompt
  carries ids and questions only. The last `{"claims": [...]}` block in the
  reply is graded: each claim must appear exactly once, equal its expected
  value, and appear in the output of an attributed target-tool call, using
  `classifyProvenance` with the task description excluded. Missing,
  duplicate, wrong, unsourced and unrequested claims fail the task. Known
  limit: sourcing is a substring heuristic, so a very short value (`1`,
  `true`) is weakly evidenced.
- **Contract.** `TaskTrace` gains optional `isolation`, `subject` and
  `claims`; `EVALS_SCHEMA_VERSION` 1.1.0 → 1.2.0 and
  `schemas/evals.schema.json` are updated together. Every new rule has a test
  whose control lands in the opposite bucket, and each implementing line was
  reverted once to confirm its test goes red.

## Deferred

`session/load` resumption · terminal/fs callback richness beyond declared-false ·
remote (HTTP/WS) ACP transports · `acpx` integration (manual smoke-test tool,
not a dependency) · permission-grant recording in TaskTrace · CLI eval-mode
wiring (`--eval` flag, JSON agent registry) · rubric prompt wording for null
tokenCost (needs mirrored gatewarden change).

## Verification pins

`@agentclientprotocol/sdk@1.1.0` shipped types (`dist/acp.d.ts`,
`dist/schema/types.gen.d.ts`) are the API ground truth this ADR was written
against; the ACP v2 RFD reworking permission-option enums
(`rfds/v2/permission-requests.md`, unmerged) is the watch item before any
enum-dependent change.
