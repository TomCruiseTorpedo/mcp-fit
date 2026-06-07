# ADR-D: Fix-mode strategy

Status: Accepted (2026-06-07).

## Context

We cannot edit a third-party server's source, yet `fix` must show a measurable before/after and must never change server behaviour.

## Decision

- `fix` generates rewritten tool and parameter descriptions plus response-shaping suggestions.
- It emits `fixes.json` — a portable rewrite set the server author can apply at source — AND applies the same rewrites through the B-001 re-presentation proxy, so the before/after eval runs without source access.
- Descriptions and metadata only; server behaviour is never altered.
- No-op honesty: when the projected gain is within reported variance, `fix` reports "no material improvement available" rather than fabricating churn.

## Consequences

- The proxy is load-bearing (justifies B-001's scope).
- The fix is non-destructive and portable; the demo before/after is honest.
