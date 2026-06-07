# mcp-fit — Project Constitution

Governing rules every contributor and agent inherits. The spec (`specs/mcp-fit/spec.md`) is the source of truth; this file is the long-lived guardrail.

## What this is

`mcp-fit` scores MCP servers for agent-usability and auto-fixes their tool descriptions. Built spec-first (SDD): code is generated from `specs/mcp-fit/spec.md` + `plan.md` + `tasks.md`, and the spec is reconciled after every change.

## Principles

- **Machine-first.** Every capability emits machine-readable artifacts (`compat.json`, `evals.jsonl`) validated against `schemas/`. Human-readable output is secondary.
- **Determinism where possible.** Static lint is reproducible — it is the badge-able number. LLM judgement is confined to the eval and fix layers and is always reported with variance.
- **Testable or it is not a requirement.** Every behaviour traces to a `GIVEN/WHEN/THEN` scenario and a test.
- **Selectivity.** Spend eval cost on multi-step, inter-tool tasks; trivial single-call tasks are low-signal by design.

## Stack conventions

- TypeScript, ESM, Node `>= 18`. Distributed via `npx`.
- MCP TypeScript SDK for client, transports, and introspection.
- Claude Agent SDK is used only behind the `Harness` interface — no Claude-specific calls leak outside `src/eval/harness.ts` (keeps v1.1 cross-harness clean).
- Shared types come from `src/types.ts` (owned by bead B-004); never redefine a contract inline.

## Testing standards

- Each bead ships unit tests for its requirement and passes `tsc --noEmit`.
- The feedback loop an agent MUST run before claiming a bead done: `tsc --noEmit`, the bead's unit tests, then `agentshield scan`.

## Security (non-negotiable)

- **No secrets in the repo.** The eval driver's Anthropic key comes from the environment (`.env`, gitignored); `.env.example` documents the variable names. History becomes public at the v1 reveal — treat every commit as public.
- **Untrusted servers.** `mcp-fit` spawns and queries arbitrary MCP servers with the user's consent; never auto-run an untrusted server without an explicit flag.
- **Eval sandbox.** The eval agent is granted only the target server's tools plus a scratch space — never the host filesystem, shell, or network beyond the target.

## Public-repo hygiene

- Apache-2.0. No `Co-Authored-By` trailers. No throwaway or "noob"-tier language in code, commits, or docs. Commit messages are concrete: what changed and why.

## Source of truth

`specs/mcp-fit/spec.md` (WHAT) · `plan.md` (HOW) · `tasks.md` (beads). Reconcile the spec after every landed change — a stale spec is a lie.
