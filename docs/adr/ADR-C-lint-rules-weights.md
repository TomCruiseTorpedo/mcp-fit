# ADR-C: Lint rule set and scoring weights

Status: Accepted (2026-06-07).

## Context

Five axes, scored 1-10. RubricRefine ablations: output-contract rules are consistently load-bearing; call-signature rules can hurt weaker models; tool-choice and data-provenance are capability-dependent.

## Decision

- Deterministic per-axis lint rules:
  - `namespacing` — prefix consistency, name collisions, vague names.
  - `tool-selection-confusion` — semantic overlap between tool descriptions (e.g. search-vs-get duplication).
  - `param-strictness` — required params without descriptions, missing enums, loose / `any` types.
  - `output-leanness` — output schema present, labeled-prose heuristics, response token size.
  - `error-helpfulness` — structured errors with recovery guidance (partly eval-derived).
- Aggregate weights: `output-leanness` x1.5 (load-bearing); `param-strictness` contribution capped (weak-model caveat); the rest x1.0. Weights live in config and are tunable without code change.
- The deterministic lint aggregate is the badge headline; the eval aggregate is reported separately with variance.

## Consequences

- Weighting is literature-aligned and defensible, and tunable as future evidence arrives.
