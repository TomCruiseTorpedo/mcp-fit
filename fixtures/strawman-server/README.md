# Strawman MCP Server

A deliberately-bad MCP server used as the `mcp-fit` demo target. Every anti-pattern is annotated in `server.ts`. The goal is to start with a low score and have `fix` mode move it from red to green.

## Running

```bash
npm install
npm start        # Starts the server over stdio (blocks — use via MCP client)
```

Or via `npx`:

```bash
npx tsx server.ts
```

## Anti-patterns (one per scorecard axis)

| Axis | Anti-pattern in this server |
|------|-----------------------------|
| `namespacing` | Tools named `process`, `get`, `change`, `remove` — vague single words, no domain prefix, inconsistent vocabulary (`remove` vs `delete`) |
| `tool-selection-confusion` | `search` and `find` both search notes; their descriptions are nearly identical; the agent cannot reliably choose one |
| `param-strictness` | All params use bare `{ type: "string" }` with no `description`; `type` params have no `enum`; `data` in `change` accepts undocumented formats (JSON or free text) |
| `output-leanness` | Every tool returns labeled prose: *"The item with identifier X was found. The title associated with this item is: Y…"* — no structured JSON, no schema |
| `error-helpfulness` | Errors are opaque: `"An error occurred."`, `"Operation failed."`, `"Error."` — no field name, no valid values, no recovery guidance |

## Domain

In-memory note store seeded with two notes:

| ID | Title | Content |
|----|-------|---------|
| `note-1` | Introduction | "Welcome to the system…" |
| `note-2` | Meeting | "Q1 review scheduled…" |

Notes are held in memory only — restarting the server resets to the seed data.

## Tools/list

| Tool name | Intended action | Anti-pattern |
|-----------|----------------|--------------|
| `process` | Create a note | Vague name; undescribed `data` and `type` params |
| `get` | Get a note by ID | One-word name; undescribed `id` param |
| `search` | Search notes (title + content) | Overlaps with `find`; param `q` has no description |
| `find` | Also search notes (title + content + tags) | Overlaps with `search`; undocumented `type` filter |
| `change` | Update a note | Vague name; `data` format is ambiguous; opaque errors |
| `remove` | Delete a note | Inconsistent with `delete` convention; opaque errors |
