#!/usr/bin/env bash
#
# Score-engine drift guard.
#
# The score engine is VENDORED IDENTICALLY between two repos:
#   - mcp-fit            (canonical "score" product; Sapling)
#   - gatewarden/packages/score  (@gatewarden/score; vendored copy)
#
# Until the engine is extracted into one shared package, these files MUST stay
# byte-identical across both repos. This check fails if a local edit changed any
# of them without updating the manifest — forcing a conscious "I changed the
# shared engine, now mirror it to the other repo" step. It is the guard that
# would have caught the retired-model break landing in one repo but not the
# other.
#
# TWO MODES, AND THE SECOND IS NOT OPTIONAL:
#
#   (default)  Every listed file matches THIS repo's recorded hash.
#   --cross    This repo's manifest is byte-identical to the PEER repo's.
#
# The default mode alone proves "internally consistent", NOT "identical across
# repos" — which is the property the guard's own header claims. Edit a shared
# file in repo A, run --update in A only, commit: A's files match A's manifest
# so A is green, and B was never touched so B is green too. The engines diverge
# and both repos pass. --cross is the assertion that closes that hole.
#
# Intentional change to the engine:
#   1) apply the SAME edit in the other repo,
#   2) regenerate the manifest in BOTH:  bash scripts/check-sync.sh --update
#   3) bash scripts/check-sync.sh --cross   (was a hand-run diff before --cross)
#
# This script is byte-identical in both repos; it works out which side it is on
# from the package name rather than carrying a per-repo constant that could
# itself be mirrored wrong.
set -euo pipefail
cd "$(dirname "$0")/.."   # package/repo root, so src/... paths resolve
MANIFEST="scripts/score-engine.sha256"
FILES=(
  src/models.ts src/eval/harness.ts src/fix/rewriter.ts src/score/rubric.ts
  # A2A card-scoring lane (ADR-F) — vendored verbatim into gatewarden/packages/score
  src/a2a/card-types.ts src/a2a/card-axes.ts src/a2a/card-rules.ts
  src/a2a/card-engine.ts src/a2a/card-scorer.ts src/a2a/signature.ts src/a2a/emit.ts
  src/a2a/verify.ts src/a2a/sign.ts
  # Outbound destination guard (SSRF) — shared by the card fetch and the jku
  # fetch. Security-critical and vendored, so it is drift-guarded like the rest:
  # a guard that is correct in one repo and stale in the other is not a guard.
  src/net/guard.ts
  schemas/card-compat.schema.json
)

# ---------------------------------------------------------------------------
# --update — regenerate this repo's manifest
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--update" ]]; then
  shasum -a 256 "${FILES[@]}" > "$MANIFEST"
  echo "score-engine manifest updated: $MANIFEST"
  echo "REMINDER: run --update in the peer repo too, then --cross to prove they match."
  exit 0
fi

# ---------------------------------------------------------------------------
# --cross — assert this manifest equals the peer repo's manifest
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--cross" ]]; then
  SELF_NAME="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
  case "$SELF_NAME" in
    mcp-fit)
      PEER_LABEL="gatewarden/packages/score"
      PEER_LOCAL="../gatewarden/packages/score/$MANIFEST"
      PEER_URL="https://raw.githubusercontent.com/TomCruiseTorpedo/gatewarden/main/packages/score/scripts/score-engine.sha256"
      ;;
    @gatewarden/score)
      PEER_LABEL="mcp-fit"
      PEER_LOCAL="../../../mcp-fit/$MANIFEST"
      PEER_URL="https://raw.githubusercontent.com/TomCruiseTorpedo/mcp-fit/main/scripts/score-engine.sha256"
      ;;
    *)
      echo "ERROR: --cross cannot identify this repo (package name '$SELF_NAME')." >&2
      echo "Expected 'mcp-fit' or '@gatewarden/score'." >&2
      exit 1
      ;;
  esac

  PEER_FILE=""
  PEER_SOURCE=""
  CLEANUP=""

  # Local peer checkout (a dev machine with both repos side by side) — a plain
  # file comparison, no network. PEER_MANIFEST overrides for unusual layouts.
  if [[ -n "${PEER_MANIFEST:-}" && -f "${PEER_MANIFEST}" ]]; then
    PEER_FILE="$PEER_MANIFEST"
    PEER_SOURCE="PEER_MANIFEST=$PEER_MANIFEST"
  elif [[ -f "$PEER_LOCAL" ]]; then
    PEER_FILE="$PEER_LOCAL"
    PEER_SOURCE="local checkout $PEER_LOCAL"
  else
    # CI checks out ONE repo and has no peer working copy, so a local diff is
    # unimplementable there. Both repos are public, so the peer's manifest is
    # fetchable unauthenticated — no token, no secret in a public workflow.
    CLEANUP="$(mktemp)"
    PEER_FILE="$CLEANUP"
    PEER_SOURCE="$PEER_URL"
    trap 'rm -f "$CLEANUP"' EXIT
    if ! curl -fsSL --max-time 30 "$PEER_URL" -o "$PEER_FILE"; then
      {
        echo "ERROR: could not fetch the $PEER_LABEL manifest from $PEER_URL"
        echo "Failing the check rather than passing it. A fetch error treated as"
        echo "a pass is precisely the silent-green failure --cross exists to stop."
      } >&2
      exit 1
    fi
    # A 200 carrying an HTML error page is not a manifest. Require the shasum
    # shape (64 hex digits, two spaces, a path) on the first line.
    if ! head -1 "$PEER_FILE" | grep -Eq '^[0-9a-f]{64}  '; then
      {
        echo "ERROR: fetched $PEER_LABEL manifest is not a shasum manifest."
        echo "First line: $(head -1 "$PEER_FILE")"
      } >&2
      exit 1
    fi
  fi

  if diff -u "$MANIFEST" "$PEER_FILE" > /dev/null; then
    echo "score manifest identical to $PEER_LABEL (via $PEER_SOURCE)"
    exit 0
  fi

  {
    echo "ERROR: score manifest DIFFERS from $PEER_LABEL."
    echo "  this repo: $SELF_NAME:$MANIFEST"
    echo "  peer:      $PEER_LABEL (via $PEER_SOURCE)"
    echo
    diff -u "$MANIFEST" "$PEER_FILE" || true
    echo
    echo "Two causes, and they need different fixes:"
    echo "  1. The shared engine really has diverged. Mirror the edit, run"
    echo "     --update in BOTH repos, and land both commits."
    echo "  2. You pushed one half of a two-repo change and the peer has not"
    echo "     landed yet. This red is the detector working, not a bug — it"
    echo "     says the mirror is incomplete. Land the other half; the window"
    echo "     should be minutes, not days."
    echo
    echo "Do NOT soften this to a warning to avoid the transient red. A"
    echo "non-blocking warning is a documented intention, which is the exact"
    echo "thing this guard replaces."
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# default — every listed file matches this repo's recorded hash
# ---------------------------------------------------------------------------

if shasum -a 256 -c "$MANIFEST"; then
  echo "score engine in sync with manifest"
else
  {
    echo "ERROR: score engine drifted from the committed manifest."
    echo "The engine is vendored identically in mcp-fit and gatewarden/packages/score."
    echo "If the change is intentional: mirror it to the other repo, run"
    echo "  bash scripts/check-sync.sh --update"
    echo "in BOTH, then prove they match with"
    echo "  bash scripts/check-sync.sh --cross"
  } >&2
  exit 1
fi
