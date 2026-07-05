# mcp-fit — Specification

> SDD source of truth: WHAT and WHY only — no tech choices (those live in `plan.md`). Scorecard axes trace to RubricRefine (arXiv 2605.09730) via the provider-side contract taxonomy. v0.1.

## Purpose

`mcp-fit` tells you whether an MCP server is *agent-friendly*, not merely API-correct. It connects to a target server, scores it across contract-usability axes, runs real agent tasks against it, and can auto-rewrite the server's tool and parameter descriptions to measurably raise that score — proving the gain with a before/after delta.

## Principles inherited

See `CLAUDE.md` (constitution). Salient here: machine-first artifacts; determinism where possible; every requirement testable; eval weights multi-step inter-tool tasks (selectivity).

## Requirements

### Requirement: Connect & Introspect

The system MUST connect to a target MCP server over stdio or remote/SSE and enumerate its `tools`, `resources`, and `prompts`.

- Scenario: stdio introspection
  - GIVEN a runnable stdio MCP server
  - WHEN `mcp-fit` connects
  - THEN it retrieves the full `tools/list` with schemas
  - AND records server metadata (name, version, transport)
- Scenario: unreachable server
  - GIVEN a target that fails to start or handshake
  - WHEN connection is attempted
  - THEN it exits non-zero with an actionable error naming the transport and the failed step
  - AND no stack-trace dump is shown

### Requirement: Re-presentation Proxy

The system MUST be able to re-present a connected target server through a local proxy that overrides tool and parameter descriptions without altering server behaviour, so scoring and eval can run against either the original or a modified description set.

- Scenario: transparent passthrough
  - GIVEN a proxied server with no overrides
  - WHEN an agent calls a tool through the proxy
  - THEN the call and result are identical to calling the server directly
- Scenario: description override
  - GIVEN a set of rewritten descriptions
  - WHEN the proxy applies them
  - THEN introspection through the proxy returns the rewritten descriptions
  - AND tool invocation behaviour is unchanged

Rationale: descriptions cannot be edited at the source of a third-party server; the proxy is what makes an honest before/after possible on servers `mcp-fit` does not own.

### Requirement: Static Lint

The system MUST run deterministic, reproducible checks on every tool contract and produce per-tool findings tagged to a scorecard axis.

- Scenario: deterministic
  - GIVEN the same server twice
  - WHEN linted
  - THEN findings and per-axis lint scores are identical
- Scenario: missing descriptions
  - GIVEN a tool lacking a `description` or with undescribed required params
  - WHEN linted
  - THEN findings are raised under `namespacing` / `param-strictness`
  - AND each finding names the offending tool and param

### Requirement: Scorecard

The system MUST score the server on five axes and emit a weighted aggregate. Each axis is scored on a 1–10 ordinal where 10 = the server makes this contract category trivial to get right, and 1–4 = very easy to get wrong (bin policy adapted from RubricRefine).

Axes and lineage:

| Axis | Traces to | Measures |
|---|---|---|
| `namespacing` | tool-choice | tools distinguishable; documented path obvious |
| `tool-selection-confusion` | tool-choice | overlapping / ambiguous tools that mislead selection |
| `param-strictness` | call-signature | unambiguous signatures; clear required args |
| `output-leanness` | output-contract | clean typed values vs labeled prose / token bloat (load-bearing) |
| `error-helpfulness` | provider-only | errors that guide recovery vs opaque failures |

The scorecard MUST separate a deterministic component from a stochastic component:

- Scenario: deterministic lint score
  - GIVEN a server
  - WHEN scored
  - THEN the lint-derived per-axis scores are reproducible
  - AND they form the badge-able headline number
- Scenario: stochastic eval score with variance
  - GIVEN LLM-judged eval scores
  - WHEN reported
  - THEN each carries a variance or confidence (over N runs, or as an ordinal bin)
  - AND a before/after delta is only claimed when it exceeds the reported variance
- Scenario: weighting
  - GIVEN axis weights
  - WHEN aggregating
  - THEN `output-leanness` is weighted as load-bearing
  - AND `param-strictness` is not blanket-penalized for weak-model-only ambiguity

Out of scope (v1.1): a sixth `data-provenance` axis (does output carry stable IDs that downstream calls can legitimately consume?). Deferred — to be designed from v1 in-vivo evidence (see Dynamic Eval), not speculation.

### Requirement: Dynamic Eval

The system MUST run a synthetic task corpus through a real agent harness against the (proxied) server and measure tool-selection accuracy, multi-step pass-rate, token cost, and error recovery.

- Scenario: behavioural pass-rate
  - GIVEN a task corpus and a connected server
  - WHEN evaluated
  - THEN each task yields pass/fail, token cost, and a chosen-tool trace in `evals.jsonl`
- Scenario: selectivity
  - GIVEN trivial single-call tasks
  - WHEN evaluated
  - THEN they run but are flagged low-signal
  - AND they do not dominate the aggregate; multi-step inter-tool tasks carry the weight
- Scenario: provenance instrumentation
  - GIVEN an eval run
  - WHEN the agent supplies a tool argument not traceable to a prior tool return or a task literal
  - THEN the trace records a `provenance:fabricated` event (evidence feeding the v1.1 data-provenance axis)
- Scenario: eval sandbox (security)
  - GIVEN an untrusted target server
  - WHEN eval runs
  - THEN the eval agent is granted only the target server's tools plus a sandboxed scratch space
  - AND never the host's real capabilities (filesystem, shell, network beyond the target)

### Requirement: Machine-Readable Output

The system MUST emit `compat.json` (per-tool, per-axis, and aggregate scores, with axis lineage and the deterministic/stochastic split) and `evals.jsonl` (one JSON object per task trace).

- Scenario: schema-stable
  - GIVEN any run
  - WHEN artifacts are emitted
  - THEN they validate against the published `compat.schema.json` and `evals.schema.json`

### Requirement: Fix Mode

The system MUST auto-rewrite tool and parameter descriptions and suggest response-shaping, apply them via the re-presentation proxy, re-run lint + eval, and emit a before/after delta. Fix MUST NOT alter server behaviour — descriptions and metadata only.

- Scenario: measurable uplift
  - GIVEN a low-scoring server
  - WHEN `fix` runs
  - THEN it produces rewritten descriptions
  - AND a delta showing per-axis score change and token-waste change
  - AND server behaviour is unchanged
- Scenario: no-op honesty
  - GIVEN an already-clean server
  - WHEN `fix` runs
  - THEN it reports "no material improvement available" rather than fabricating churn

### Requirement: Demo Fixtures

The system MUST ship a deliberately-bad strawman MCP server, and support running against at least one real public MCP server.

- Scenario: strawman before/after (must-ship)
  - GIVEN the strawman server
  - WHEN `fix` runs end-to-end
  - THEN its aggregate moves from red to green

Note: the strawman before/after is load-bearing for the demo; the real-public-server run is the first scope to drop under time pressure.

### Requirement: CLI & Distribution

The system MUST be runnable via `npx mcp-fit <subcommand>` with a one-command quickstart and committed sample artifacts.

- Scenario: quickstart
  - GIVEN a fresh environment
  - WHEN a user runs the documented `npx mcp-fit` quickstart against the strawman
  - THEN they get a rendered scorecard with no prior install step

### Requirement: A2A Agent Card Scoring

The system MUST score an A2A v1.0 Agent Card for agent-usability with the same
deterministic, offline, keyless guarantees as the MCP static lint, emitting a
`card-compat.json` artifact that validates against `schemas/card-compat.schema.json`.
The shipped MCP contract (`AxisName`, `compat.schema.json`) is frozen; card scoring
uses its own axis vocabulary and schema (ADR-F).

- Scenario: deterministic card lint
  - GIVEN the same Agent Card JSON twice
  - WHEN scored via `mcp-fit card`
  - THEN findings, per-axis scores, and the aggregate are identical
- Scenario: REQUIRED-field floor
  - GIVEN a card missing a proto-REQUIRED field (e.g. `skills` or an interface `url`)
  - WHEN linted
  - THEN an error-severity finding names the missing field under `card-completeness`
    or `interface-hygiene`
- Scenario: signature structural tier
  - GIVEN a card with a `signatures[]` entry whose `protected` header decodes with
    `alg`/`typ`/`kid` present
  - WHEN linted (no verification keys supplied)
  - THEN the signature report carries `tier: "structural"`
  - AND cryptographic verification is NOT claimed
- Scenario: crypto verification round-trip (ADR-F4)
  - GIVEN a card signed per §8.4.2 (default-strip, exclude `signatures`, JCS, JWS)
    and a trusted JWKS containing the signer's public key
  - WHEN verified with `--verify-keys`
  - THEN the signature report carries `tier: "crypto-pinned"`
  - AND a card with explicit default values verifies identically to one without them
- Scenario: tamper detection
  - GIVEN a signed card whose content was modified after signing
  - WHEN verified
  - THEN NO tier is granted and an error-severity finding is raised
- Scenario: jku is opt-in
  - GIVEN a signed card whose header carries a `jku`
  - WHEN verified WITHOUT `--verify-jku`
  - THEN no network fetch occurs and the tier stays `structural`
- Scenario: security declaration consistency
  - GIVEN a card whose `securityRequirements` (or legacy `security`) references a
    scheme absent from `securitySchemes`
  - WHEN linted
  - THEN an error-severity finding names the undeclared scheme
- Scenario: offline by default
  - GIVEN a local card file path
  - WHEN scored
  - THEN no network request is made
  - AND fetching a live card requires the explicit `--url` flag (well-known path
    appended for bare origins per A2A §8.2)

### Requirement: ACP Eval Harness

The system MUST provide an `AcpHarness` implementing the ADR-B `Harness`
interface that drives any ACP-registry coding agent as the eval driver: the
agent is spawned as a subprocess, receives the target MCP server via
`session/new mcpServers`, and the harness reconstructs the tool-call
transcript by observing `tool_call`/`tool_call_update` session updates
(ADR-G). No ACP types leak outside `src/eval/acp-harness.ts` and
`src/eval/acp-agents.ts`.

- Scenario: observe-don't-intercept
  - GIVEN an ACP agent that calls target-server tools
  - WHEN a task runs
  - THEN the trace's `chosenTools` and provenance events are reconstructed
    from tool-call updates (folded by `toolCallId`)
  - AND `sandbox.callTool()` is never invoked
- Scenario: token cost is honest
  - GIVEN any ACP run
  - WHEN the trace is emitted
  - THEN `tokenCost` is null (not measured), never a fabricated number
- Scenario: degraded-trace detection
  - GIVEN an agent that omits `rawInput` on a tool call, or whose tool
    activity cannot be attributed to any target-server tool
  - WHEN the trace is emitted
  - THEN `degraded` is true
- Scenario: no-contact detection
  - GIVEN an agent that never issues a tool call
  - WHEN the trace is emitted
  - THEN `pass` is false AND `degraded` is true
- Scenario: headless permissions
  - GIVEN an agent that raises `session/request_permission`
  - WHEN the harness answers
  - THEN the `allow_once`-kind option is preferred and the grant is logged
