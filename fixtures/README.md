# fixtures/

Demo fixtures for `mcp-fit`. This directory is owned by bead B-003 and contains:

- `tasks/` — Synthetic task corpus consumed by the dynamic-eval runner (B-005)
- `strawman-server/` — Deliberately-bad MCP server used as the primary demo target

## Quick start

```bash
# Start the strawman server (stdio transport)
cd fixtures/strawman-server
npm install
npm start
```

```bash
# View the task corpus
cat fixtures/tasks/tasks.json
```

## Purpose

The strawman server is the load-bearing demo artifact. Running `mcp-fit fix` against it must move the aggregate score from red to green, proving the lint → eval → fix → re-score pipeline end to end.

See each subdirectory's `README.md` for detail.
