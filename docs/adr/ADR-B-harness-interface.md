# ADR-B: Harness eval-driver interface

Status: Accepted (2026-06-07).

## Context

The dynamic eval drives an agent against the (proxied) target server. v1 uses the Claude Agent SDK. We want v1.1 cross-harness coverage, and the Agent Client Protocol (ACP — JSON-RPC editor-to-agent, Zed/JetBrains, 25+ agents by 2026) offers a uniform way to drive heterogeneous coding agents.

## Decision

- Define a minimal interface: `Harness.runTask(task, toolset, sandbox): Promise<TaskTrace>`. The toolset comes from the re-presentation proxy; the sandbox bounds capabilities; the trace is normalized (chosen tools, token cost, pass/fail, provenance events).
- v1 ships one implementation, `ClaudeHarness` (Claude Agent SDK), under `src/eval/harness/`. No Claude-specific calls leak outside that adapter.
- v1.1 cross-harness is achieved with a single ACP `Harness` adapter that drives any ACP-compatible agent against the proxied server — not N per-vendor SDKs. The interface is kept ACP-adapter-ready (an external agent driven over a toolset, returning a normalized trace).

## Consequences

- v1 is Claude-only, but the ecosystem expansion is one adapter.
- ACP shapes the abstraction; it does not enter v1 scope. `mcp-fit` scores MCP servers (the agent-to-tool seam); ACP is the editor-to-agent seam, a complementary layer and a candidate future scoring target.
