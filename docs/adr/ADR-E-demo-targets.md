# ADR-E: Demo-target strategy

Status: Accepted (2026-06-07).

## Context

We need a controlled before/after (for the showcase) and an external-credibility run, at zero additional dollar cost.

## Decision

- Ship a deliberately-bad strawman MCP server in `fixtures/strawman-server/`, exhibiting one anti-pattern per axis (bad names, undescribed params, prose-blob outputs, opaque errors). This is the must-ship A/B — `fix` moves it red to green.
- Real public server: `czlonkowski/n8n-mcp` (MIT, ~21.6k stars), scoped to its 7 standalone core tools — `tools_documentation`, `search_nodes`, `get_node`, `validate_node`, `validate_workflow`, `search_templates`, `get_template`. Run via `npx n8n-mcp` with NO `N8N_API_URL` / `N8N_API_KEY` set, so the 13 management tools (which require an n8n instance and mutate state) are excluded. This yields zero dollar cost, read-only / side-effect-free tools, and a realistic tool-selection-confusion surface (search-vs-get, nodes-vs-templates, node-vs-workflow validation).
- The real-server run is droppable under time pressure; the strawman before/after is load-bearing.

## Consequences

- A zero-cost, side-effect-free real target that genuinely exercises the namespacing and tool-selection-confusion axes.
- `mcp-fit`'s connector must support scoping to a tool subset (or rely on the API-less server exposing only the 7 core tools) — noted for B-001.
