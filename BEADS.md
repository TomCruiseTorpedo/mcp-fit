# mcp-fit — BEADS (execution decomposition)

> Execution-side conversion of `tasks.md`. `tasks.md` is the SDD-side checkable plan; this file is the live work-unit map that the Gas Town `mcpfit` rig dispatches. Each `B-00N` logical task maps 1:1 to a routable bead `mcpfit-00N` in the rig Dolt DB (`~/gt/mcpfit/mayor/rig/.beads`). Lean bead bodies point back here and to the rig-cloned `specs/mcp-fit/spec.md`, `plan.md`, and `docs/adr/`; this file carries the full cold-start brief per bead.

## Ground rules (inherited, do not relitigate)

- **Disjoint file ownership** is the primary restack-conflict guard — no two beads write the same file. Shared contracts are imported from B-004 only, never redefined.
- **ADR-A is frozen** (accepted + committed `98300963`): the scorecard/artifact schema and shared types are a fixed contract. Wave-1 beads build against that frozen contract, which is what makes the four parallel without blocking each other.
- **Per-bead close-the-loop gate** (before any `sl` PR submit): `tsc --noEmit` clean + the bead unit tests green + `agentshield scan --path <worktree>` clean.
- **Public-repo hygiene:** no Co-Authored-By trailer, no secrets, no "noob"-tier language (repo flips public at v1).
- **Merge strategy = `local`** for v1: work stays on each polecat feature branch for human / Sapling-PR review and the Auditor gate. Nothing auto-merges to `main`.

## Bead → wave → dependency map

| Bead | Logical | Wave | Depends on | Owns (files) | Worker-config |
|---|---|---|---|---|---|
| `mcpfit-001` | B-001 | 1 | — | `src/connect/` (`client.ts`, `transports.ts`, `introspect.ts`, `proxy.ts`) | SONNET-MEDIUM |
| `mcpfit-002` | B-002 | 1 | — | `src/lint/` (`engine.ts`, `rules.ts`) | MIXED |
| `mcpfit-003` | B-003 | 1 | — | `fixtures/` (`tasks/`, `strawman-server/`) | HAIKU-ONLY |
| `mcpfit-004` | B-004 | 1 | — | `src/report/emit.ts`, `src/types.ts`, `schemas/compat.schema.json`, `schemas/evals.schema.json` | SONNET-MEDIUM |
| `mcpfit-005` | B-005 | 2 | B-001, B-003 | `src/eval/` (`runner.ts`, `harness.ts`, `sandbox.ts`) | SONNET-MEDIUM |
| `mcpfit-006` | B-006 | 2 | B-002, B-005 | `src/score/` (`scorer.ts`, `rubric.ts`, `axes.ts`) | SONNET-MEDIUM |
| `mcpfit-007` | B-007 | 3 | B-001, B-005, B-006 | `src/fix/` (`rewriter.ts`, `revalidate.ts`, `delta.ts`) | SONNET-MEDIUM |
| `mcpfit-008` | B-008 | 3 | B-001, B-002, B-004, B-005, B-006, B-007 | `src/cli.ts`, `bin/mcp-fit`, `package.json`, `tsconfig.json` (+ `README.md`) | MIXED |

Wave 1 = `mcpfit-001..004`, slung now (parallel, no inter-dependencies). Waves 2–3 stay blocked in bd until their blockers close, then are slung in later passes.

## Wave 1 cold-start briefs

### B-001 / `mcpfit-001` — MCP connector + re-presentation proxy

Build `src/connect/`. Connect to a target MCP server over stdio and remote/SSE using the official MCP TypeScript SDK; enumerate `tools` / `resources` / `prompts` with full schemas and record server metadata (name, version, transport). On handshake failure, exit non-zero with an actionable error naming the transport and the failed step — no stack-trace dump. Build the re-presentation proxy: it sits between an agent and the target and can override tool / parameter descriptions while leaving behaviour identical (transparent passthrough when there are no overrides; rewritten descriptions surfaced through introspection when overrides are applied). The proxy is what makes an honest before/after possible on third-party servers (B-007 fix-mode depends on it). Import shared types from `src/types.ts` (B-004) — do not redefine them. Satisfies spec: Connect & Introspect, Re-presentation Proxy.

### B-002 / `mcpfit-002` — static lint engine + rule set

Build `src/lint/`. Deterministic, reproducible per-tool contract checks; every finding tagged to a scorecard axis (`namespacing`, `tool-selection-confusion`, `param-strictness`, `output-leanness`, `error-helpfulness`). Same server linted twice MUST yield identical findings and per-axis lint scores (this is the badge-able headline). Missing tool description or undescribed required params raise findings under `namespacing` / `param-strictness`, each naming the offending tool and param. Per ADR-C: per-axis rules, weights `output-leanness` ×1.5 and `param-strictness` capped. Import axis/finding types from `src/types.ts` (B-004). Satisfies spec: Static Lint.

### B-003 / `mcpfit-003` — task corpus + strawman bad server

Build `fixtures/`. A synthetic task corpus under `fixtures/tasks/` (mix of trivial single-call tasks flagged low-signal and multi-step inter-tool tasks that carry the eval weight) and a deliberately-bad strawman MCP server under `fixtures/strawman-server/` whose contracts are easy to get wrong (ambiguous tool names, missing descriptions, prose-bloated outputs) so `fix` can move it red→green end-to-end. Mechanical authoring — no novel architecture. Satisfies spec: Demo Fixtures + supplies eval inputs for B-005.

### B-004 / `mcpfit-004` — artifact emitter + schemas + shared types (the contract)

Build `src/report/emit.ts`, `src/types.ts`, and `schemas/`. This is the contract every other bead imports — land the shared types exactly as frozen by ADR-A. Emit `compat.json` (per-tool, per-axis, and aggregate scores, with axis lineage and an explicit deterministic-vs-stochastic split) and `evals.jsonl` (one JSON object per task trace). Both MUST validate against the published `compat.schema.json` and `evals.schema.json` (`ajv` or equivalent). Define `src/types.ts` as the single source of the scorecard, finding, axis, and trace types. Satisfies spec: Machine-Readable Output. Resolves the ADR-A artifacts.

## Wave 2 / Wave 3 briefs (blocked until deps close)

- **B-005 / `mcpfit-005`** — dynamic-eval runner in `src/eval/`: drives the `ClaudeHarness` (`Harness.runTask(task, toolset, sandbox)`, ADR-B) against the proxied server; emits per-task pass/fail, token cost, chosen-tool trace to `evals.jsonl`; records a `provenance:fabricated` event when an agent supplies a tool argument not traceable to a prior return or a task literal; runs in a sandbox granted only the target tools + scratch space (never host filesystem / shell / wider network). Multi-step → sling with `--ralph`. Depends: B-001, B-003.
- **B-006 / `mcpfit-006`** — scorer in `src/score/`: combines deterministic lint sub-scores with the `contract-rubric` instance-specific rubric loop (verifier generates a task/registry-specific rubric, scores 1–10, early-stops at 10 or on patience, reports variance; top-bin reliability only). Deterministic and stochastic components reported separately. Multi-step → `--ralph`. Depends: B-002, B-005.
- **B-007 / `mcpfit-007`** — fix-mode in `src/fix/`: auto-rewrite tool/param descriptions, apply via the proxy (descriptions only, behaviour unchanged, ADR-D), re-run lint + eval, emit before/after delta; "no material improvement available" honesty on already-clean servers. Depends: B-001, B-005, B-006.
- **B-008 / `mcpfit-008`** — CLI + packaging: `npx mcp-fit <subcommand>` one-command quickstart against the strawman, committed sample artifacts, `package.json` / `tsconfig.json` / `bin/mcp-fit`, README quickstart. Depends: B-001, B-002, B-004, B-005, B-006, B-007.

## Dispatch log

- **Convoy `hq-cv-wwpuq`** ("Tracking mcp-fit v1 build") — tracks all 8 beads, `--merge=local`, owned (caller-managed lifecycle via `gt convoy land`). Created 2026-06-07.
- **Wave 1 slung 2026-06-07** — `gt sling mcpfit-001 mcpfit-002 mcpfit-003 mcpfit-004 mcpfit --create --merge=local --no-convoy --no-boot --max-concurrent 2`. 4/4 succeeded, formula `mol-polecat-work` bonded, work attached. One Pi polecat per bead (process-confirmed `comm=pi` → usage-credits pool):

  | Bead | Polecat | Status |
  |---|---|---|
  | `mcpfit-001` | `rust` | in-progress |
  | `mcpfit-002` | `chrome` | in-progress |
  | `mcpfit-003` | `nitro` | in-progress |
  | `mcpfit-004` | `guzzle` | in-progress |

- Merge stance: each polecat lands on its own feature branch; nothing auto-merges to `main`. Review / Sapling-PR + Auditor gate before landing. Waves 2–3 (`mcpfit-005..008`) stay blocked in bd until their Wave-1 blockers close, then sling in later passes.
- Monitor: `gt convoy status hq-cv-wwpuq` · `gt session list` · `gt seance --talk <session-id>` to interview a polecat · `bd -C ~/gt/mcpfit/mayor/rig list`.

### Wave 1 result — built & per-bead green, contract divergent (2026-06-07 ~04:42)

All 4 beads closed in ~21 min. 75 tests pass (rust 30 / chrome 22 / guzzle 23), AgentShield A across all, every polecat stayed in its file lane. Verified by `~/gt/mcpfit/WAVE1-REPORT.md`.

**But not integration-ready.** Parallel fan-out produced **three divergent `src/types.ts`** (rust 141L / chrome 160L / guzzle 218L) because the contract file did not exist on the consumer branches. Consumer vocabulary diverged from guzzle's canonical: `Axis`→`AxisName`, `AXES`→`AXIS_NAMES`, `McpTool`/`ToolDef`, `ServerIntrospection` absent from canonical; and guzzle's canonical omits the MCP-input shapes the consumers need. Root cause: ADR-A pinned the *ownership rule* but not the concrete identifier names, and "never redefine" is structurally impossible under parallel fan-out when the contract bead runs concurrently with its consumers. Lesson for future waves: **land the contract bead first, then fan out consumers** — or pin exact identifier names in the ADR.

### B-009 — Wave-1 integration (added 2026-06-07, slung to polecat `shiny`)

Serialization point (not disjoint-lane): unify `src/types.ts` into one canonical contract (guzzle's scorecard/trace types + the MCP-input shapes, preferring official MCP SDK `Tool`/`Resource`/`Prompt` aliases over hand-rolled variants), reconcile rust/chrome imports, consolidate root config, whole-repo `tsc` + tests green. Depends on B-001..004; **now blocks B-005..008** (Wave 2 cannot go ready until the contract is unified). `--merge=local` → leaves a green integrated branch for review; landing into the Sapling SSOT (`~/mcp-fit`) is the human follow-on, then Wave 2 branches off it.

### B-009 converged + verified green (2026-06-07 ~06:28, polecat `shiny`)

Independently verified (not just self-report): exactly ONE `src/types.ts`; all 5 lanes present; no consumer redefining the contract; `tsc --noEmit` EXIT=0; `bun test` 75/75 pass. shiny reconciled `McpTool`/`ToolDef` as `ToolDef extends McpTool`, caught a `Finding` field divergence (`toolName/paramName` → `tool/param`) beyond the brief, added `ruleId?` for lint traceability. Integrated commit `7cb9da7`.

### Wave 2 dispatch + the base-branch lesson

gt spawns polecat worktrees off **`origin/<base-branch>`** in the bare repo — its dispatch model is GitHub-origin-centric (Wave 1 branched off `origin/main`). `--merge=local` opted out of landing, so "advance the base for the next wave" became a manual step. To avoid a premature remote push (repo still private; standing rule = no remote push without explicit ask), created a **local remote-tracking ref `refs/remotes/origin/integration` → `7cb9da7`** (no GitHub write, reversible) and slung Wave 2 with `--base-branch integration`. Real `origin/main` untouched (`cb08bf6`); the formal land to `origin/main` / Sapling SSOT remains the human gate.

- **B-005 / `mcpfit-005`** slung off `integration` → polecat `fury` (pi-confirmed). Worktree verified to contain the full integrated tree. (Respawn counter had tripped on 3 base-branch fumbles → `gt sling respawn-reset mcpfit-005` cleared it.)
- **B-005 verified green** (polecat `fury`, commit `f9f190e`): 140/140 tests, tsc EXIT=0, one `src/types.ts` (no re-fork), `src/eval/{sandbox,harness,runner}.ts` import `TaskTrace`/`ToolDef` from the canonical contract and redefine nothing. **The Wave-1 fix held** — a dependent bead built on the rolling base consumed the shared contract correctly. Sandbox denies host fs/shell/network; `provenance:fabricated` fires on the fabricated-arg test.
- **Rolling base advanced** to `f9f190e` (FF; `integration` + `origin/integration` both updated; real `origin/main` still `cb08bf6`).
- **B-006 / `mcpfit-006`** slung off advanced `integration` → polecat `thunder` (pi-confirmed; worktree has the eval lane = on the advanced base). Scorer + rubric loop.
- **Rolling-base protocol** (per subsequent bead): bead lands green → verify → `git branch -f integration <sha>` + `git -C .repo.git update-ref refs/remotes/origin/integration <sha>` → sling next off `integration`. Remaining after 006: B-007 (fix-mode; deps 001/005/006/009) then B-008 (CLI; deps most) — a genuine dependent chain = the natural GT+Sapling stacked-PR pilot candidate.

### B-006 verified green + Wave 2 complete (polecat `thunder`, commit `07415cd`)

153/153 tests, tsc EXIT=0, one contract; `src/score/{scorer,rubric,axes}.ts` import `AxisName`/`AXIS_NAMES`/`LineageCategory` from the canonical contract (the *unified* names — integration fix propagated). Contract-rubric loop (generate rubric → score 1-10 early-stop → mean±stdev), deterministic lint aggregate = badge headline, stochastic eval reported separately per ADR-C. Rolling base advanced to `07415cd`.

### PAUSED at 007 for the Sapling stacked-PR pilot (decided: Sapling-as-landing)

Wave 2 done (005, 006 closed). 007 ready, **not slung** — pausing per plan. Pilot scope chosen = **Sapling-as-landing**: 007→008 will still execute via the proven rolling-integration fleet method; the *pilot* is submitting the finished work as a linear Sapling stack of PRs (`sl pr submit`; ghstack not installed). §14-Q3 resolved → `sl pr submit`. Both clones = same GitHub repo; rig bare repo is locally fetchable by the SSOT clone (no GitHub round-trip until submit). Rig integration history is merge-based → must linearize (one commit/PR per bead) for the stack. `sl pr submit` = remote PR creation = explicit-authorization gate (repo still private).

### v1 COMPLETE — all 9 beads, landed as a ghstack (2026-06-07)

B-007 fix-mode (`dust`, 174 tests, reuses connect proxy) and B-008 CLI+packaging (`scavenger`, 348 tests, `npx mcp-fit` builds + runs, sample scorecard shipped) closed and verified green. Total spend ~CA$22 / 260.

**Stacked-PR landing — two methods compared:**
- `sl pr submit` (PRs #1-3, now closed): one branch per commit, all base=`main` → cumulative diffs → required manual `gh pr edit --base` reparenting.
- **`sl ghstack submit` (PRs #4-8, open): synthetic `gh/<user>/N/{base,head}` branches → native incremental diffs (foundation 26 → eval 8 → scorer 4 → fix 4 → cli 5), zero reparent tax.** This is the chosen stacked-PR path for monorepo work.

**Follow-ups:** demo polish (confirm `mcp-fit fix` shows strawman red→green — needs an API key; lint alone scores it 8.5); fleet cleanup (land convoy `hq-cv-wwpuq`, stop idle polecats); merge #4-8 → main on human review; flip repo public at v1.
