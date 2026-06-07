# ADR-A: Scorecard & artifact schema and shared types

Status: Accepted (2026-06-07). Gates Wave 1.

## Context

All Wave-1 beads (B-001, B-002, B-004) depend on shared contracts — the scorecard, axis scores, eval traces, and the `compat.json` / `evals.jsonl` shapes. These must be frozen before parallel work so file-ownership stays disjoint and no bead reinvents the types.

## Decision

- Canonical TypeScript types live in `src/types.ts`, owned by bead B-004; every other bead imports from it and never redefines a contract.
- JSON Schemas in `schemas/compat.schema.json` and `schemas/evals.schema.json`, each carrying a `schemaVersion`.
- `compat.json` shape: `server { name, version, transport }`; `axes { <axis>: { score (1-10), lineage (RubricRefine category), kind ('deterministic' | 'eval'), findings[], variance? } }` over the five axes; `aggregate { lintScore (deterministic headline), evalScore { mean, stdev, n }, weighted }`; `tools[] { name, findings[] }`.
- `evals.jsonl`: one object per task — `{ taskId, multiStep, lowSignal, pass, tokenCost, chosenTools[], provenanceEvents[], rubric { score, round } }`.

## Consequences

- The schema is frozen before the convoy; any change is a new ADR.
- Deterministic (lint) and stochastic (eval) scores are first-class-separate in the artifact, enabling an honest, badge-able headline.
