# sample-artifacts

Pre-generated artifacts from running `mcp-fit scan` against the bundled strawman server.

These serve as:
- **Reference output** showing what a real `compat.json` looks like.
- **Acceptance test evidence** for the B-008 CLI bead.
- **Documentation aid** — readers can inspect `compat.json` without running the tool.

## Files

| File | Description |
|------|-------------|
| `compat.json` | Full scorecard for `strawman v0.1.0` (lint-only; no eval) |
| `evals.jsonl` | Task traces — empty in lint-only mode (no dynamic eval run) |

## Reproducing

From the repo root:

```bash
npm install
cd fixtures/strawman-server && npm install && cd ../..
npm run build
node dist/cli.js scan \
  --out sample-artifacts \
  -- fixtures/strawman-server/node_modules/.bin/tsx fixtures/strawman-server/server.ts
```

## Notes on the scores

The strawman is *deliberately bad* — it exhibits one anti-pattern per axis at the semantic level. However, static lint rules detect *structural* issues only (missing descriptions, missing required-param descriptions, etc.). Semantic issues (e.g., output-leanness violations that manifest only at runtime) require the dynamic eval layer, which needs `ANTHROPIC_API_KEY`.

The `param-strictness` axis scores 1/10 because all 7 required parameters across the 6 tools have no descriptions — this is a structural error the linter catches immediately.
