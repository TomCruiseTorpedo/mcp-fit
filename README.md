# mcp-fit

[![CI](https://github.com/TomCruiseTorpedo/mcp-fit/actions/workflows/ci.yml/badge.svg)](https://github.com/TomCruiseTorpedo/mcp-fit/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Score MCP servers for agent-usability — then auto-fix them.**

Plenty of tools let you *expose* an MCP server. None tell you whether it is actually *agent-friendly*: clean namespacing, strict params, lean typed outputs, helpful errors, low tool-selection confusion. `mcp-fit` does.

It connects to a target MCP server, scores it across five contract-usability axes, runs real agent tasks against it, and — in `fix` mode — rewrites the server's tool and parameter descriptions to measurably raise that score, proving the gain with a before/after delta.

The scorecard axes are the provider-side dual of the RubricRefine tool-use contract taxonomy (arXiv 2605.09730): `namespacing`, `tool-selection-confusion`, `param-strictness`, `output-leanness`, `error-helpfulness`.

## Quickstart

Score the bundled strawman server (a deliberately bad in-memory note store):

> Scanning **your own** server needs no clone → `npx mcp-fit scan -- <your-server-command>`. The walkthrough below uses the repo's bundled strawman fixture, so it is clone-based.

```bash
# 1. Clone and install
git clone <repo-url> mcp-fit && cd mcp-fit
npm install

# 2. Install strawman dependencies
cd fixtures/strawman-server && npm install && cd ../..

# 3. Build mcp-fit
npm run build

# 4. Scan the strawman — renders a scorecard and writes compat.json + evals.jsonl
node dist/cli.js scan \
  --out ./out \
  -- fixtures/strawman-server/node_modules/.bin/tsx fixtures/strawman-server/server.ts
```

Expected output (lint-only — the deterministic badge scores only the axes static lint can verify; behavioural axes are eval-only):

```
┌────────────────────────────────────────────────────────────┐
│  mcp-fit scorecard · strawman v0.1.0 (stdio)               │
├────────────────────────────────────────────────────────────┤
│  Axis                             Score   Grade Findings   │
├────────────────────────────────────────────────────────────┤
│  namespacing                      9  /10  A     0err 1warn │
│  tool-selection-confusion         —  /10  ·     eval-only  │
│  param-strictness                 1  /10  F     7err 0warn │
│  output-leanness                  —  /10  ·     eval-only  │
│  error-helpfulness                —  /10  ·     eval-only  │
├────────────────────────────────────────────────────────────┤
│  LINT SCORE (deterministic)   5.6 / 10                     │
│  WEIGHTED AGGREGATE           5.6 / 10  [grade: C]         │
└────────────────────────────────────────────────────────────┘
```

The `—` axes are **eval-only**: static lint cannot grade runtime output shape, error quality, or tool-selection confusion, so the deterministic badge does not claim a verdict on them. Scoring those stochastically uses the dynamic eval harness (`src/eval/`, needs `ANTHROPIC_API_KEY`), which is currently programmatic-only — not yet exposed as a CLI flag.

### Keyless red→green (no API key)

`fixtures/strawman-fixed-server` is the strawman with clean contracts. Scan both and compare the deterministic LINT SCORE — a reproducible before/after with no LLM call:

```bash
# install the fixed-server fixture's deps (first time only)
cd fixtures/strawman-fixed-server && npm install && cd ../..

# bad: 5.6 / 10  (param-strictness F)
node dist/cli.js scan -- fixtures/strawman-server/node_modules/.bin/tsx fixtures/strawman-server/server.ts
# fixed: 10 / 10  (A)
node dist/cli.js scan -- fixtures/strawman-fixed-server/node_modules/.bin/tsx fixtures/strawman-fixed-server/server.ts
```

> See `sample-artifacts/` for a pre-generated `compat.json` and `evals.jsonl` from the strawman run.

### Auto-fix mode

Generate improved descriptions and show the before/after delta:

```bash
node dist/cli.js fix \
  --out ./out \
  -- fixtures/strawman-server/node_modules/.bin/tsx fixtures/strawman-server/server.ts
```

> **Note:** with `ANTHROPIC_API_KEY` set, `fix` uses Claude to rewrite descriptions; without it, `fix` falls back to rule-based heuristics (no LLM call). Set the key in your environment for Claude-powered rewrites.

### SSE / HTTP transport

```bash
node dist/cli.js scan --sse http://localhost:3001/sse
node dist/cli.js fix  --sse http://localhost:3001/sse --out ./out
```

### After `npm link` or `npm install -g mcp-fit`

```bash
mcp-fit scan -- node my-server.js
mcp-fit fix  -- npx -y @my-org/my-server --out ./results
mcp-fit help
```

## CLI reference

```
mcp-fit scan [--out <dir>] -- <command> [args...]
mcp-fit scan [--out <dir>] --sse <url>
mcp-fit fix  [--out <dir>] -- <command> [args...]
mcp-fit fix  [--out <dir>] --sse <url>
mcp-fit help
```

| Option | Default | Description |
|--------|---------|-------------|
| `--out <dir>` | `.` | Directory for emitted artifacts |
| `--sse <url>` | — | SSE transport URL (instead of `-- cmd`) |

## Scorecard axes

| Axis | Lineage | Measures |
|------|---------|----------|
| `namespacing` | tool-choice | tools distinguishable; documented path obvious |
| `tool-selection-confusion` | tool-choice | overlapping / ambiguous tools that mislead selection |
| `param-strictness` | call-signature | unambiguous signatures; clear required args |
| `output-leanness` | output-contract | typed values vs labeled prose / token bloat |
| `error-helpfulness` | provider-only | errors that guide recovery vs opaque failures |

Scores are 1–10 ordinal (10 = trivially correct; 1–4 = very easy to get wrong).
The lint score is deterministic and badge-able. The eval score (stochastic, via the `src/eval/` harness) is reported with variance.

## Artifacts

| File | Schema | Content |
|------|--------|---------|
| `compat.json` | `schemas/compat.schema.json` | Full scorecard (all axes, findings, aggregate) |
| `evals.jsonl` | `schemas/evals.schema.json` | Per-task agent traces (one JSON object per line) |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile src/ → dist/
npm test            # vitest run
```

## Security

- `ANTHROPIC_API_KEY` — used by `fix` for Claude-powered rewrites (falls back to rule-based without it) and by the eval harness. Never commit it; load from your environment or a gitignored `.env`.
- `mcp-fit` spawns and queries servers with your consent; never auto-runs an untrusted server without an explicit command.

## Architecture

```
src/connect/   MCP client, transports, introspect, proxy   B-001
src/lint/      deterministic rule engine + rules            B-002
fixtures/      strawman bad server + task corpus            B-003
src/report/    artifact emitter + schema validation         B-004
src/eval/      dynamic-eval runner (Claude SDK harness)     B-005
src/score/     scorer + contract-rubric loop                B-006
src/fix/       description rewriter + re-validate + delta   B-007
src/cli.ts     CLI entry point (this bead)                  B-008
```

Source of truth: `specs/mcp-fit/spec.md` · Implementation plan: `plan.md` · Issue tracking: `tasks.md`

## License

Apache-2.0 — see `LICENSE`.
