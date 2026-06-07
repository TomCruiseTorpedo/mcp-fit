# mcp-fit — Tasks (bead decomposition)

> Ordered, checkable decomposition of `plan.md`. Each bead has explicit, disjoint file ownership — no two beads write the same file (the primary restack-conflict guard). Shared contracts live in B-004's `src/types.ts` + `schemas/`, frozen by ADR-A before Wave 1 starts.

## Pre-convoy gate

- [ ] Resolve ADR-A…E; Auditor reviews. ADR-A (schema + shared types) MUST land first — it gates all of Wave 1.

## Wave 1 — parallel, independent (after ADR-A)

- [ ] **B-001 — MCP connector + re-presentation proxy.** Files: `src/connect/` (`client.ts`, `transports.ts`, `introspect.ts`, `proxy.ts`). Worker-Config: SONNET-MEDIUM-WORKERS (transport + proxy state). Satisfies: Connect & Introspect, Re-presentation Proxy.
- [ ] **B-002 — static lint engine + rule set.** Files: `src/lint/` (`engine.ts`, `rules.ts`). Worker-Config: MIXED. Satisfies: Static Lint (deterministic).
- [ ] **B-003 — task corpus + strawman bad server.** Files: `fixtures/` (`tasks/`, `strawman-server/`). Worker-Config: HAIKU-ONLY (mechanical authoring). Satisfies: Demo Fixtures, eval inputs.
- [ ] **B-004 — artifact emitter + schemas + shared types.** Files: `src/report/emit.ts`, `src/types.ts`, `schemas/compat.schema.json`, `schemas/evals.schema.json`. Worker-Config: SONNET-MEDIUM-WORKERS (the contract everyone depends on). Satisfies: Machine-Readable Output. Resolves ADR-A artifacts.

## Wave 2 — after their Wave-1 deps

- [ ] **B-005 — dynamic-eval runner (Claude SDK Harness, sandboxed).** Files: `src/eval/` (`runner.ts`, `harness.ts`, `sandbox.ts`). Depends: B-001, B-003. Worker-Config: SONNET-MEDIUM-WORKERS (reasoning-heavy). Satisfies: Dynamic Eval (incl. provenance instrumentation + sandbox).
- [ ] **B-006 — scorer + rubric loop.** Files: `src/score/` (`scorer.ts`, `rubric.ts`, `axes.ts`). Depends: B-002, B-005. Worker-Config: SONNET-MEDIUM-WORKERS (the contract-rubric judge loop). Satisfies: Scorecard (deterministic + stochastic split, weighting).

## Wave 3

- [ ] **B-007 — fix-mode rewriter + re-validate.** Files: `src/fix/` (`rewriter.ts`, `revalidate.ts`, `delta.ts`). Depends: B-005, B-006, B-001 (proxy). Worker-Config: SONNET-MEDIUM-WORKERS. Satisfies: Fix Mode.
- [ ] **B-008 — CLI + packaging + README.** Files: `src/cli.ts`, `bin/mcp-fit`, `package.json`, `tsconfig.json` (and updates `README.md`). Depends: most. Worker-Config: MIXED. Satisfies: CLI & Distribution.

## Per-bead verification (close the loop)

Each bead, before its `sl` PR submit: `tsc --noEmit` + the bead's unit tests green + `agentshield scan`.

## File-ownership map (disjoint — verified)

`src/connect/` → B-001 · `src/lint/` → B-002 · `fixtures/` → B-003 · `src/report/` + `src/types.ts` + `schemas/` → B-004 · `src/eval/` → B-005 · `src/score/` → B-006 · `src/fix/` → B-007 · `src/cli.ts` + `bin/` + root config → B-008. No overlap. Shared types are imported from B-004 only — never redefined.
