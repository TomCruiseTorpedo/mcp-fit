/**
 * A2A Agent Card scoring — canonical contract (ADR-F).
 *
 * This is the single source of truth for the card-scoring types: A2A wire
 * shapes (tolerant readers of an Agent Card JSON document) and the
 * card-scorecard output contract. Every card-scoring module imports from here
 * and never redefines these contracts. Changing this file is an ADR revision.
 *
 * The MCP scorecard contract in src/types.ts is FROZEN and unaffected — card
 * scoring deliberately does not extend `AxisName` or `Scorecard` (ADR-F1).
 *
 * Wire shapes follow A2A spec v1.0.1 (`a2aproject/A2A`, `specification/a2a.proto`
 * is normative per spec §1.4; JSON wire format is camelCase per §5.5). All wire
 * fields are optional here — presence is a LINT concern (card-completeness),
 * not a parse concern.
 *
 * Spec: A2A Agent Card Scoring (specs/mcp-fit/spec.md)
 * ADR: ADR-F (docs/adr/ADR-F-a2a-card-scoring.md)
 */

import type { FindingSeverity } from '../types.js';

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/** Bump this when the card-compat.json shape changes in a breaking way. */
export const CARD_SCHEMA_VERSION = '1.0.0';

/** A2A protocol version this scorer's rules were verified against. */
export const A2A_SPEC_VERSION = '1.0.1';

// ---------------------------------------------------------------------------
// A2A wire shapes (tolerant) — Agent Card JSON per spec §4.4 / §8.5
// ---------------------------------------------------------------------------

/** One entry of `supportedInterfaces` (spec §5.2). */
export interface AgentInterfaceJson {
  url?: string;
  protocolBinding?: string;
  protocolVersion?: string;
  [key: string]: unknown;
}

/** One entry of `capabilities.extensions` (spec §4.4.4). */
export interface AgentExtensionJson {
  uri?: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The `capabilities` object (spec §4.4.3). */
export interface AgentCapabilitiesJson {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
  extensions?: AgentExtensionJson[];
  [key: string]: unknown;
}

/** One entry of `skills` (spec §4.4.5 — note: NO parameter schema exists). */
export interface AgentSkillJson {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: unknown[];
  [key: string]: unknown;
}

/** One entry of `signatures` — a JWS with detached payload (spec §8.4.2). */
export interface AgentCardSignatureJson {
  protected?: string;
  signature?: string;
  header?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A tolerant reading of an Agent Card JSON document.
 *
 * `securityRequirements` is the proto-derived name; the spec's own §8.5 sample
 * uses `security` — both are accepted on input (ADR-F5).
 */
export interface AgentCardJson {
  name?: string;
  description?: string;
  version?: string;
  provider?: { organization?: string; url?: string; [key: string]: unknown };
  supportedInterfaces?: AgentInterfaceJson[];
  capabilities?: AgentCapabilitiesJson;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: AgentSkillJson[];
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: unknown[];
  security?: unknown[];
  signatures?: AgentCardSignatureJson[];
  iconUrl?: string;
  documentationUrl?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Card scorecard axes (ADR-F2)
// ---------------------------------------------------------------------------

/**
 * The seven card-usability axes. All are deterministic — every axis is
 * statically gradable from the card document alone (no eval split in v1).
 */
export type CardAxisName =
  | 'card-completeness'
  | 'skill-namespacing'
  | 'skill-selection-overlap'
  | 'signature-hygiene'
  | 'security-declaration-consistency'
  | 'extension-hygiene'
  | 'interface-hygiene';

/** Every card axis in a fixed order for iteration. */
export const CARD_AXIS_NAMES: readonly CardAxisName[] = [
  'card-completeness',
  'skill-namespacing',
  'skill-selection-overlap',
  'signature-hygiene',
  'security-declaration-consistency',
  'extension-hygiene',
  'interface-hygiene',
] as const;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * A single diagnostic finding from the card lint, tagged to a card axis.
 * Mirrors `Finding` (src/types.ts) with card-appropriate targets: `skill`
 * names the offending skill (by id), `field` names the offending card field.
 */
export interface CardFinding {
  /** Lint rule identifier, e.g. 'no-missing-skill-description'. */
  ruleId?: string;
  axis: CardAxisName;
  severity: FindingSeverity;
  message: string;
  /** Offending skill id (or name fallback), if applicable. */
  skill?: string;
  /** Offending card field path, if applicable, e.g. 'supportedInterfaces[0].url'. */
  field?: string;
}

// ---------------------------------------------------------------------------
// Axis score
// ---------------------------------------------------------------------------

/**
 * Score for a single card axis. Unlike the MCP `AxisScore`, `score` is never
 * null: every card axis is deterministic (ADR-F2), so the badge always has a
 * measured verdict.
 */
export interface CardAxisScore {
  /** 1–10 ordinal. */
  score: number;
  kind: 'deterministic';
  findings: CardFinding[];
}

// ---------------------------------------------------------------------------
// Signature report (ADR-F4)
// ---------------------------------------------------------------------------

/**
 * Verification tiers for Agent Card signatures (spec §8.4).
 * - 'structural': signatures present and structurally well-formed (v1 ships this).
 * - 'crypto-pinned': JWS verified against a local trusted key store (deferred).
 * - 'crypto-jku': keys fetched from the header `jku` (deferred, opt-in network).
 */
export type SignatureTier = 'structural' | 'crypto-pinned' | 'crypto-jku';

/**
 * The signature portion of a card scorecard. `tier` is the highest tier the
 * card's signatures PASSED — null when absent or structurally invalid.
 * Cryptographic validity is never claimed by the 'structural' tier.
 */
export interface SignatureReport {
  present: boolean;
  tier: SignatureTier | null;
  findings: CardFinding[];
}

// ---------------------------------------------------------------------------
// Per-skill report
// ---------------------------------------------------------------------------

/** Findings for a single skill (keyed by skill id, name fallback). */
export interface SkillReport {
  id: string;
  findings: CardFinding[];
}

// ---------------------------------------------------------------------------
// Card scorecard — root shape for card-compat.json
// ---------------------------------------------------------------------------

/** Identity of the scored card. */
export interface CardMeta {
  name: string;
  version: string;
}

/**
 * The complete card scorecard emitted as `card-compat.json`.
 * Validates against `schemas/card-compat.schema.json`.
 */
export interface CardScorecard {
  schemaVersion: string;
  card: CardMeta;
  axes: Record<CardAxisName, CardAxisScore>;
  aggregate: { lintScore: number; weighted: number };
  skills: SkillReport[];
  signature: SignatureReport;
}
