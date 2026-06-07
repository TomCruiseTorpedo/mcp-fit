# strawman-fixed server

The `strawman-server` done right. Same in-memory note-store domain, but with
agent-friendly contracts on the axes static lint can assess:

- **namespacing** — clear, domain-prefixed tool names (`note_create`, `note_get`,
  `note_search`, `note_list`, `note_update`, `note_delete`), each with a
  description that states what it does.
- **param-strictness** — every parameter is described; required vs optional is
  explicit; an `enum` is used where the value set is bounded (`note_list.sort`).

## Keyless red→green demo (no API key)

Scan the bad and fixed servers and compare the deterministic **LINT SCORE**:

    cd fixtures/strawman-server && npm install && cd ../..
    cd fixtures/strawman-fixed-server && npm install && cd ../..
    npm run build

    node bin/mcp-fit scan -- fixtures/strawman-server/node_modules/.bin/tsx fixtures/strawman-server/server.ts
    node bin/mcp-fit scan -- fixtures/strawman-fixed-server/node_modules/.bin/tsx fixtures/strawman-fixed-server/server.ts

Expected: the strawman scores ~5.6/10 (param-strictness F), the fixed server
10/10 (A) — a reproducible improvement with no LLM call.

The behavioural axes (`output-leanness`, `error-helpfulness`,
`tool-selection-confusion`) show `—` in both: they are eval-only — static lint
cannot grade runtime output shape / error quality / tool-selection, so the
deterministic badge does not claim a verdict on them. Run `scan --eval`
(needs an `ANTHROPIC_API_KEY`) to score those.
