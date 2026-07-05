#!/usr/bin/env bash
#
# Score-engine drift guard.
#
# The score engine is VENDORED IDENTICALLY between two repos:
#   - mcp-fit            (canonical "score" product; Sapling)
#   - gatewarden/packages/score  (@gatewarden/score; vendored copy)
#
# Until the engine is extracted into one shared package, these four files MUST
# stay byte-identical across both repos. This check fails if a local edit
# changed any of them without updating the manifest — forcing a conscious
# "I changed the shared engine, now mirror it to the other repo" step. It is the
# guard that would have caught the retired-model break landing in one repo but
# not the other.
#
# Intentional change to the engine:
#   1) apply the SAME edit in the other repo,
#   2) regenerate the manifest in BOTH:  bash scripts/check-sync.sh --update
#   3) confirm both repos' scripts/score-engine.sha256 are byte-identical.
set -euo pipefail
cd "$(dirname "$0")/.."   # package/repo root, so src/... paths resolve
MANIFEST="scripts/score-engine.sha256"
FILES=(
  src/models.ts src/eval/harness.ts src/fix/rewriter.ts src/score/rubric.ts
  # A2A card-scoring lane (ADR-F) — vendored verbatim into gatewarden/packages/score
  src/a2a/card-types.ts src/a2a/card-axes.ts src/a2a/card-rules.ts
  src/a2a/card-engine.ts src/a2a/card-scorer.ts src/a2a/signature.ts src/a2a/emit.ts
  src/a2a/verify.ts
  schemas/card-compat.schema.json
)

if [[ "${1:-}" == "--update" ]]; then
  shasum -a 256 "${FILES[@]}" > "$MANIFEST"
  echo "score-engine manifest updated: $MANIFEST"
  exit 0
fi

if shasum -a 256 -c "$MANIFEST"; then
  echo "score engine in sync with manifest"
else
  {
    echo "ERROR: score engine drifted from the committed manifest."
    echo "The engine is vendored identically in mcp-fit and gatewarden/packages/score."
    echo "If the change is intentional: mirror it to the other repo, run"
    echo "  bash scripts/check-sync.sh --update"
    echo "in BOTH, and verify both scripts/score-engine.sha256 files match."
  } >&2
  exit 1
fi
