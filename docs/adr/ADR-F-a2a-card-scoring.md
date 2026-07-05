# ADR-F: A2A Agent Card scoring (`mcp-fit card`)

- Status: accepted
- Date: 2026-07-05
- Owners: mcp-fit maintainers

## Context

A2A (Agent2Agent, Linux Foundation) reached spec v1.0 in early 2026. Its Agent Card
(`/.well-known/agent-card.json`, RFC 8615) is the discovery surface for a remote agent —
the structural dual of an MCP server's `tools/list`. mcp-fit already scores the latter;
scoring the former extends the product one protocol layer up.

A spec-depth verification pass (2026-07-05, against `a2aproject/A2A` tag v1.0.1 — the
normative source is `specification/a2a.proto` per spec §1.4) established two facts that
shape this ADR:

1. **The MCP axis vocabulary does not port.** `AgentSkill` carries no parameter schema
   (its only fields are `id`, `name`, `description`, `tags`, `examples`, `inputModes`,
   `outputModes`, `securityRequirements`) — invocation flows through Message/Part, so
   `param-strictness` has nothing to bind to, and the behavioural axes
   (`output-leanness`, `error-helpfulness`, `tool-selection-confusion`) have no static
   card surface. Only the namespacing rules transfer.
2. **The card has its own deterministic lint surface the MCP side lacks:** REQUIRED
   field annotations, JWS signatures (spec §8.4), a `securitySchemes` /
   `securityRequirements` consistency contract, protocol extensions
   (`capabilities.extensions[]`, §4.4.4), and transport interface declarations (§5.2).

## Decision

### F1 — Card scoring lives inside mcp-fit, with a frozen MCP contract

New module `src/a2a/` plus a `mcp-fit card` CLI subcommand. The shipped MCP contract is
untouched: `AxisName`, `AXIS_NAMES`, `DETERMINISTIC_AXES`, `Scorecard`, and
`schemas/compat.schema.json` are frozen. Card scoring gets parallel types
(`CardAxisName`, `CardScorecard`, `CardFinding`) in its own canonical module
`src/a2a/card-types.ts` and its own artifact + schema
(`card-compat.json` / `schemas/card-compat.schema.json`, independent `schemaVersion`).

Rejected alternative: a sibling package (`a2a-fit`). Clean schema separation, but it
duplicates the engine conventions, doubles the release surface, and the lint machinery
here is already protocol-agnostic — the rule vocabulary is what changes.

### F2 — Card-native axis vocabulary (seven axes, all deterministic)

| Axis | What it grades | Lineage |
|---|---|---|
| `card-completeness` | REQUIRED-field presence per proto `field_behavior` annotations | spec floor |
| `skill-namespacing` | skill name/description discoverability | transferred (MCP `namespacing`) |
| `skill-selection-overlap` | pairwise skill id/name/tag ambiguity | transferred (MCP `tool-selection-confusion`, statically gradable here) |
| `signature-hygiene` | JWS signature presence + structural validity (§8.4) | card-native |
| `security-declaration-consistency` | requirements ⊆ declared schemes; per-scheme required subfields | card-native |
| `extension-hygiene` | extension URI validity, description presence, `required:true` surfacing | card-native |
| `interface-hygiene` | interface URL absoluteness/HTTPS, known bindings, versions | card-native |

Every axis is statically gradable → every card axis has `kind: 'deterministic'` and a
non-null score. There is no eval split in v1 (a future `message/send` behavioural
harness would mirror the MCP deterministic/eval split).

Scoring mechanics reuse the engine conventions verbatim: per-axis
`10 − Σ severity-deduction` (error 2, warning 1, info 0), floor 1, weighted mean
rounded to one decimal.

**Ungradable floors (badge-inflation guard).** An axis with nothing to grade must
not award a vacuous 10 — the card edition of the run-1 strawman lesson that
produced the MCP side's null eval-only axes. Deterministic rule: an invalid
document (non-object input) floors every axis to 1; a card with zero skills
floors the two skill axes (`skill-namespacing`, `skill-selection-overlap`) to 1
while the remaining axes grade what is measurable.

### F3 — Weights (project convention, tunable)

The A2A spec has no normative text on description quality, so weights are an mcp-fit
convention, not spec-derived:

- `card-completeness` × 1.25 — REQUIRED violations are spec noncompliance, weight them up.
- `signature-hygiene` × 0.75 — signing is recommended-not-required in v1.0; absence
  should register, not dominate.
- all others × 1.0.

These live in `src/a2a/card-axes.ts` and are the sanctioned tuning point.

### F4 — Signature verification is tiered; all three tiers shipped

- `structural` (shipped v1): `signatures[]` present, `protected`/`signature` are
  well-formed base64url, decoded protected header carries `alg`/`typ`/`kid` (MUST,
  §8.4.2), `alg` is not `none`.
- `crypto-pinned` (shipped 2026-07-05, `src/a2a/verify.ts`): §8.4.3 verification —
  default-strip → exclude `signatures` → JCS (RFC 8785, `canonicalize`) → JWS verify
  (`jose`) against a local trusted key store (`--verify-keys <jwks.json>`). The
  acceptance gate is self-signed round-trip vectors (the spec's §8.4.2 example is not
  self-contained — no public key is published), including the default-explicitness
  stability property the stripping exists for.
- `crypto-jku` (shipped 2026-07-05, opt-in network, `--verify-jku`): fetch keys from
  the header `jku`. Proves integrity + key possession, not provenance — the trust
  anchor is the key store, which is why it never runs by default and ranks below
  `crypto-pinned`.
- A FAILED cryptographic verification grants NO tier (worse than unverified — the
  card was tampered with or signed over a different payload) and raises an
  error-severity finding.
- Unknown default-valued fields stripped during canonicalization are surfaced as an
  info finding (the C4 cross-spec-version ambiguity), never silently eaten.

The `SignatureReport.tier` field carries the tier so downstream consumers (gatewarden
attach, W4) can gate on it.

### F5 — Input tolerance rules

- Accept both `securityRequirements` (proto-derived name) and `security` (the spec's
  own §8.5 sample spelling) on input; treat presence of either as the requirements list.
- Unknown `protocolBinding` values (outside `JSONRPC` / `GRPC` / `HTTP+JSON`) are a
  warning, not an error — forward-compatibility per spec §5.7.
- Unknown top-level fields are ignored (spec §5.7 SHOULD-ignore).

### F6 — Network fetch is flag-gated

`mcp-fit card <path>` is offline. Fetching a live card requires the explicit
`--url <url>` form (constitution: no network without an explicit flag); a bare origin
gets `/.well-known/agent-card.json` appended per §8.2.

## Consequences

- gatewarden (W4) can consume `scoreCardLintOnly` + `SignatureReport` at attach time
  through the existing vendored-score seam. The four sync-manifest files
  (`scripts/score-engine.sha256`) are untouched by this change.
- The lint helpers shared with the MCP rules (`areSimilarNames`) are exported from
  `src/lint/rules.ts` rather than duplicated.
- Deferred, in order: card fix-mode, behavioural card axes, gRPC/REST-specific
  interface probing. (Crypto signature tiers shipped 2026-07-05 — see F4.)

## Verification pins

Spec basis re-verifiable against `a2aproject/A2A` tag v1.0.1:
`specification/a2a.proto` (REQUIRED annotations), `docs/specification.md`
§4.4.4 (extensions), §5.2/§5.7 (interfaces), §8.2 (well-known URI), §8.4 (signing),
§8.5 (sample card — source of the `security` spelling tolerance).
