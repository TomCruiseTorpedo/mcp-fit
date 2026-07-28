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
- **Untrusted servers.** `mcp-fit` spawns and queries arbitrary MCP servers with the user's consent. Be exact about when that happens: the DEFAULT `scan` path already spawns the server process and runs the MCP `initialize` handshake, so a malicious server's payload can fire without any extra flag. A flag can gate the *additional* blast radius of LLM-driven tool calls; it cannot make the default execution-free. Never describe scanning as execution-free.
- **Eval sandbox — posture-scoped, never absolute.** The eval agent is granted only the target server's tools plus a scratch space, and tool names matching known host-capability patterns (`read_file`, `shell`, `fs_*`, …) are denied. That filter is IN-PROCESS: the harness shares the host's PID, filesystem, network and user, so a hostile tool under an unrecognised name (`saveNote`, `fetch_url`) is not contained by it, and nothing constrains the spawned server process at all. Every emitted `compat.json` records the isolation that actually applied, in `isolationPosture`. Claims in this file must not outrun that field — if the posture says `none`, the docs do not get to say "isolated".
- **Isolation is measured, not assumed.** Before a scan trusts the target, a containment probe runs in the EXACT spawn context and tries to read a host file and resolve an external name. Whatever it finds is what `compat.json` reports — a failed probe forces `isolationPosture.level` to `none` regardless of what else was attempted. A spawned server also gets a disposable HOME (its cwd is deliberately left alone; the reason is on `createDisposableWorkspace`). `--live`, which lets a model drive the target's tools, is REFUSED when the probe finds no containment. None of this is isolation: absolute paths still resolve and the process runs as the invoking user. Do not describe it as isolation.
- **A canary, and what it does not cover.** A honeypot credentials file is planted in the disposable HOME; its value appearing in the server's output proves the server went hunting for credentials. mcp-fit sees the STDIO channel only, so this catches harvest-and-echo, NOT a server that reads the file and POSTs it itself. A silent canary means "not caught on this channel", never "no exfiltration occurred".
- **Outbound destinations are guarded.** Every outbound fetch whose URL is chosen by untrusted input — the `card --url` target, the A2A `jku` JWKS URL read from inside the card being scored — goes through `src/net/guard.ts`, which refuses loopback / private / link-local addresses (including the cloud metadata endpoint) on the first hop and on every redirect, classifying RESOLVED addresses rather than hostname strings. Its one documented residual is DNS rebinding. Any new outbound fetch uses the guard; adding a bare `fetch()` on an untrusted URL is a regression.

## Public-repo hygiene

- Apache-2.0. No `Co-Authored-By` trailers. No throwaway or "noob"-tier language in code, commits, or docs. Commit messages are concrete: what changed and why.

## Source of truth

`specs/mcp-fit/spec.md` (WHAT) · `plan.md` (HOW) · `tasks.md` (beads). Reconcile the spec after every landed change — a stale spec is a lie.
