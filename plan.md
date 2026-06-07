# mcp-fit — Plan (HOW)

> Commits the implementation approach against `specs/mcp-fit/spec.md`. The spec stays stable; this plan may change. ADRs for Auditor review are listed at the end.

## Stack & libraries

- TypeScript (ESM), distributed via `npx` (a `bin` entry). Rationale: the MCP TS SDK is first-class and `npx` is the lowest-friction public try-it-yourself path.
- Official MCP TypeScript SDK — client, stdio + SSE transports, introspection.
- Claude Agent SDK — the v1 eval driver, behind a pluggable `Harness` interface (an OpenAI-Responses profile is a v1.1 addition; do not couple to Claude specifics outside the Harness adapter).
- `ajv` (or equivalent) — JSON Schema validation for emitted artifacts.

## Architecture (component → owning bead)

- `src/connect/` — MCP client, stdio + SSE transports, introspection, and the re-presentation proxy (description override + transparent passthrough). [B-001]
- `src/lint/` — deterministic rule engine; rules tagged to axes. [B-002]
- `fixtures/` — synthetic task corpus + the strawman bad server. [B-003]
- `src/report/` + `schemas/` + `src/types.ts` — artifact emitter, the canonical shared types, and the JSON Schemas. Frozen first (ADR-A) so Wave-1 beads build against stable contracts. [B-004]
- `src/eval/` — dynamic-eval runner: drives the Harness against the proxied server, sandboxed; emits traces including provenance events. [B-005]
- `src/score/` — scorer: combines deterministic lint sub-scores with the LLM-judge eval rubric loop into per-axis and aggregate scores. [B-006]
- `src/fix/` — description rewriter + re-validation via the proxy; before/after delta. [B-007]
- `src/cli.ts` + packaging — subcommands, quickstart, README, `package.json`. [B-008]

## Scoring engine

- Lint score: deterministic rules → per-axis sub-scores (reproducible, badge-able).
- Eval score: the `contract-rubric` instance-specific rubric loop — a verifier generates a task- and registry-specific rubric, scores 1–10, and early-stops at 10 or on patience; report with variance. Calibrate top-bin reliability only.
- Aggregate: weighted; `output-leanness` load-bearing; `param-strictness` capped to avoid weak-model over-penalty (ablation-informed). Deterministic and stochastic components are reported separately in `compat.json`.

## The proxy (why it exists)

You cannot edit a third-party server's descriptions. The proxy re-presents the target with rewritten descriptions so `fix`'s before/after is measurable on servers `mcp-fit` does not own. The same mechanism gives the strawman a clean A/B.

## Trade-offs & alternatives

- Deterministic lint plus LLM-judge eval kept as two layers: lint gates cheaply and reproducibly; eval validates behaviour at a cost. An eval-only design was rejected — it is not reproducible and cannot anchor a badge.
- Instance-specific rubric over a fixed one: beats fixed (paper: +0.04–0.12) but costs inference — gated by the selectivity principle (skip trivial single-call tasks).

## Risks / open questions

- LLM-judge calibration → mitigate with top-bin reliability + variance reporting.
- Eval token cost → selectivity gate + a small corpus in v1.
- `npx` cold start; real-public-server availability / auth (the droppable demo target).
- Sapling ↔ GitHub: confirm `sl pr submit` vs `sl ghstack` against the live repo before Phase 3.

## ADRs (accepted 2026-06-07 — full text in `docs/adr/`; Auditor re-reviews in the convoy flow)

- ADR-A: scorecard + artifact schema and shared types in `src/types.ts` + `schemas/` (frozen first; gates Wave 1).
- ADR-B: `Harness.runTask(task, toolset, sandbox)`; v1 = `ClaudeHarness`; v1.1 cross-harness via a single ACP adapter.
- ADR-C: per-axis lint rules; weights `output-leanness` x1.5, `param-strictness` capped, rest x1.0; deterministic aggregate is the badge.
- ADR-D: `fix` emits portable `fixes.json` + applies via the proxy for a non-destructive before/after; descriptions only.
- ADR-E: strawman bad server (must-ship A/B) + `czlonkowski/n8n-mcp` 7 core tools, API-less (zero cost, read-only).

## Traceability

Every requirement in `spec.md` maps to one or more beads in `tasks.md`; the schema ADR (A) is the contract all Wave-1 beads share.
