/**
 * A2A Agent Card lint rules (ADR-F2).
 *
 * Each rule is deterministic: given the same card it always produces the same
 * findings. Rules are tagged to the card axis they feed. Signature analysis is
 * NOT a rule — it lives in signature.ts because it also produces the
 * SignatureReport; the engine merges its findings into `signature-hygiene`.
 *
 * Rule shape mirrors src/lint/rules.ts:
 *   id       — stable kebab-case identifier used in CardFinding.ruleId
 *   axis     — which card axis this rule feeds
 *   check()  — receives the whole card; returns 0-N findings
 *
 * Spec basis: A2A v1.0.1 — REQUIRED annotations from specification/a2a.proto,
 * extensions §4.4.4, interfaces §5.2/§5.7, well-known/sample §8.2/§8.5.
 */

import { areSimilarNames } from '../lint/rules.js';
import type {
  AgentCardJson,
  AgentSkillJson,
  CardAxisName,
  CardFinding,
} from './card-types.js';

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

export interface CardRule {
  readonly id: string;
  readonly axis: CardAxisName;
  readonly description: string;
  check(card: AgentCardJson): CardFinding[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Non-empty string check. */
function isFilled(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Non-empty array check. */
function isFilledArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Stable identity for a skill inside findings and reports: id, then name,
 * then a positional label. The engine uses the same key to build SkillReports.
 */
export function skillKey(skill: AgentSkillJson, index: number): string {
  if (isFilled(skill.id)) return skill.id;
  if (isFilled(skill.name)) return skill.name;
  return `skill[${index}]`;
}

/** The card's skills as a safe array. */
function skillsOf(card: AgentCardJson): AgentSkillJson[] {
  return Array.isArray(card.skills)
    ? card.skills.map((s) => (typeof s === 'object' && s !== null ? s : {}))
    : [];
}

/**
 * The card's security requirements — accepts both the proto-derived
 * `securityRequirements` and the spec §8.5 sample's `security` spelling
 * (ADR-F5). Each entry is an object whose keys reference scheme names; a
 * `{ schemes: {...} }` wrapper is tolerated.
 */
function requirementEntries(source: unknown[] | undefined): Record<string, unknown>[] {
  if (!Array.isArray(source)) return [];
  return source
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) =>
      typeof e['schemes'] === 'object' && e['schemes'] !== null
        ? (e['schemes'] as Record<string, unknown>)
        : e,
    );
}

// ---------------------------------------------------------------------------
// axis: card-completeness — REQUIRED-field floor (proto field_behavior)
// ---------------------------------------------------------------------------

/** Card-level REQUIRED string fields (skill description is graded under skill-namespacing). */
const CARD_REQUIRED_STRINGS = ['name', 'description', 'version'] as const;

const cardRequiredFields: CardRule = {
  id: 'card-required-fields',
  axis: 'card-completeness',
  description:
    'Card-level REQUIRED fields (name, description, version, capabilities, defaultInputModes, defaultOutputModes) must be present and non-empty.',
  check(card) {
    const findings: CardFinding[] = [];
    const miss = (field: string): void => {
      findings.push({
        ruleId: 'card-required-fields',
        axis: 'card-completeness',
        severity: 'error',
        field,
        message: `Card is missing REQUIRED field "${field}" (A2A proto field_behavior).`,
      });
    };

    for (const field of CARD_REQUIRED_STRINGS) {
      if (!isFilled(card[field])) miss(field);
    }
    if (typeof card.capabilities !== 'object' || card.capabilities === null) {
      miss('capabilities');
    }
    for (const field of ['defaultInputModes', 'defaultOutputModes'] as const) {
      if (!isFilledArray(card[field])) miss(field);
    }
    return findings;
  },
};

const skillsRequired: CardRule = {
  id: 'skills-required',
  axis: 'card-completeness',
  description: 'The skills array is REQUIRED and must be non-empty.',
  check(card) {
    if (!isFilledArray(card.skills)) {
      return [
        {
          ruleId: 'skills-required',
          axis: 'card-completeness',
          severity: 'error',
          field: 'skills',
          message: 'Card declares no skills — an agent card without skills is undiscoverable.',
        },
      ];
    }
    return [];
  },
};

const skillRequiredFields: CardRule = {
  id: 'skill-required-fields',
  axis: 'card-completeness',
  description:
    'Skill-level REQUIRED fields (id, name, tags) must be present and non-empty.',
  check(card) {
    const findings: CardFinding[] = [];
    skillsOf(card).forEach((skill, i) => {
      const key = skillKey(skill, i);
      for (const field of ['id', 'name'] as const) {
        if (!isFilled(skill[field])) {
          findings.push({
            ruleId: 'skill-required-fields',
            axis: 'card-completeness',
            severity: 'error',
            skill: key,
            field: `skills[${i}].${field}`,
            message: `Skill "${key}" is missing REQUIRED field "${field}".`,
          });
        }
      }
      if (!isFilledArray(skill.tags)) {
        findings.push({
          ruleId: 'skill-required-fields',
          axis: 'card-completeness',
          severity: 'error',
          skill: key,
          field: `skills[${i}].tags`,
          message: `Skill "${key}" is missing REQUIRED non-empty "tags" — tags drive skill discovery.`,
        });
      }
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// axis: skill-namespacing — transferred from the MCP namespacing rules
// ---------------------------------------------------------------------------

const noMissingSkillDescription: CardRule = {
  id: 'no-missing-skill-description',
  axis: 'skill-namespacing',
  description:
    'Every skill must have a non-empty description so client agents can select it.',
  check(card) {
    const findings: CardFinding[] = [];
    skillsOf(card).forEach((skill, i) => {
      if (!isFilled(skill.description)) {
        const key = skillKey(skill, i);
        findings.push({
          ruleId: 'no-missing-skill-description',
          axis: 'skill-namespacing',
          severity: 'error',
          skill: key,
          field: `skills[${i}].description`,
          message: `Skill "${key}" has no description.`,
        });
      }
    });
    return findings;
  },
};

/**
 * Generic skill names create selection ambiguity. Superset of the MCP
 * vague-tool-name vocabulary plus agent-domain generics.
 */
const GENERIC_SKILL_NAMES = new Set([
  'call', 'delete', 'do', 'exec', 'execute', 'fetch', 'get', 'go',
  'list', 'post', 'put', 'read', 'run', 'send', 'set', 'write',
  'agent', 'ask', 'assist', 'chat', 'general', 'help', 'info', 'query',
  'search', 'skill', 'task', 'tool',
]);

const vagueSkillName: CardRule = {
  id: 'vague-skill-name',
  axis: 'skill-namespacing',
  description:
    'Skill names that are too short or domain-generic confuse client skill selection.',
  check(card) {
    const findings: CardFinding[] = [];
    skillsOf(card).forEach((skill, i) => {
      const name = isFilled(skill.name) ? skill.name : null;
      if (name === null) return; // skill-required-fields covers absence
      if (GENERIC_SKILL_NAMES.has(name.toLowerCase()) || name.length <= 2) {
        findings.push({
          ruleId: 'vague-skill-name',
          axis: 'skill-namespacing',
          severity: 'warning',
          skill: skillKey(skill, i),
          message: `Skill name "${name}" is too generic; prefer a domain-specific descriptive name.`,
        });
      }
    });
    return findings;
  },
};

/**
 * When most skill ids share a naming prefix, outliers are harder to discover.
 * Mirrors the MCP prefix-consistency rule: fires only when ≥ 3 skills exist
 * and one prefix covers > 50 % of them.
 */
const skillPrefixConsistency: CardRule = {
  id: 'skill-prefix-consistency',
  axis: 'skill-namespacing',
  description:
    'Skill ids on the same card should use a consistent naming prefix to aid discovery.',
  check(card) {
    const skills = skillsOf(card);
    if (skills.length < 3) return [];

    const getPrefix = (name: string): string | null => {
      const m = name.match(/^([a-z][a-z0-9]*)(?:[_\-]|(?=[A-Z]))/);
      return m ? (m[1] ?? null) : null;
    };

    const ids = skills.map((s, i) => ({ skill: s, index: i, id: isFilled(s.id) ? s.id : null }));
    const prefixes = ids
      .map(({ id }) => (id === null ? null : getPrefix(id)))
      .filter((p): p is string => p !== null);
    if (prefixes.length < 2) return [];

    const freq: Record<string, number> = {};
    for (const p of prefixes) freq[p] = (freq[p] ?? 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const [dominant, count] = sorted[0] ?? ['', 0];
    if (count / skills.length <= 0.5) return [];

    const findings: CardFinding[] = [];
    for (const { skill, index, id } of ids) {
      if (id === null) continue;
      if (getPrefix(id) !== dominant) {
        findings.push({
          ruleId: 'skill-prefix-consistency',
          axis: 'skill-namespacing',
          severity: 'warning',
          skill: skillKey(skill, index),
          message: `Skill id "${id}" does not share the dominant prefix "${dominant}"; consider renaming for consistency.`,
        });
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// axis: skill-selection-overlap — transferred from tool-selection-confusion,
// statically gradable here because the card IS the selection surface
// ---------------------------------------------------------------------------

const duplicateSkillIds: CardRule = {
  id: 'duplicate-skill-ids',
  axis: 'skill-selection-overlap',
  description: 'Skill ids must be unique within a card.',
  check(card) {
    const findings: CardFinding[] = [];
    const seen = new Set<string>();
    skillsOf(card).forEach((skill, i) => {
      if (!isFilled(skill.id)) return;
      if (seen.has(skill.id)) {
        findings.push({
          ruleId: 'duplicate-skill-ids',
          axis: 'skill-selection-overlap',
          severity: 'error',
          skill: skillKey(skill, i),
          field: `skills[${i}].id`,
          message: `Skill id "${skill.id}" is declared more than once.`,
        });
      }
      seen.add(skill.id);
    });
    return findings;
  },
};

/**
 * Skills with very similar names or ids risk confusing client skill selection.
 * One finding per pair, emitted from the lexicographically-later skill —
 * the same pairing contract as the MCP overlapping-tool-names rule, using the
 * same exported similarity helper so both rule sets agree on "similar".
 */
const overlappingSkillNames: CardRule = {
  id: 'overlapping-skill-names',
  axis: 'skill-selection-overlap',
  description: 'Skills with very similar names or ids may mislead skill selection.',
  check(card) {
    const findings: CardFinding[] = [];
    const skills = skillsOf(card);
    skills.forEach((skill, i) => {
      const key = skillKey(skill, i);
      for (let j = 0; j < skills.length; j++) {
        if (j === i) continue;
        const other = skills[j];
        if (other === undefined) continue;
        const otherKey = skillKey(other, j);
        if (key <= otherKey) continue; // emit once per pair
        const nameSimilar =
          isFilled(skill.name) && isFilled(other.name) && skill.name !== other.name
            ? areSimilarNames(skill.name, other.name)
            : false;
        const idSimilar =
          isFilled(skill.id) && isFilled(other.id) && skill.id !== other.id
            ? areSimilarNames(skill.id, other.id)
            : false;
        if (nameSimilar || idSimilar) {
          findings.push({
            ruleId: 'overlapping-skill-names',
            axis: 'skill-selection-overlap',
            severity: 'warning',
            skill: key,
            message: `Skill "${key}" is very similar to "${otherKey}"; overlapping ${nameSimilar ? 'names' : 'ids'} confuse skill selection.`,
          });
        }
      }
    });
    return findings;
  },
};

const identicalTagSets: CardRule = {
  id: 'identical-tag-sets',
  axis: 'skill-selection-overlap',
  description:
    'Two skills with identical tag sets are indistinguishable to tag-driven discovery.',
  check(card) {
    const findings: CardFinding[] = [];
    const skills = skillsOf(card);
    const tagKey = (s: AgentSkillJson): string | null => {
      if (!isFilledArray(s.tags)) return null;
      const tags = s.tags.filter((t): t is string => isFilled(t));
      if (tags.length === 0) return null;
      return [...new Set(tags.map((t) => t.toLowerCase()))].sort().join(' ');
    };
    skills.forEach((skill, i) => {
      const key = skillKey(skill, i);
      const mine = tagKey(skill);
      if (mine === null) return;
      for (let j = 0; j < i; j++) {
        const other = skills[j];
        if (other === undefined) continue;
        if (tagKey(other) === mine) {
          findings.push({
            ruleId: 'identical-tag-sets',
            axis: 'skill-selection-overlap',
            severity: 'warning',
            skill: key,
            message: `Skill "${key}" has the same tag set as "${skillKey(other, j)}"; identical tags defeat tag-driven selection.`,
          });
          break; // one finding per skill is enough
        }
      }
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// axis: security-declaration-consistency
// ---------------------------------------------------------------------------

/** Recognized proto-oneof wrapper keys and their REQUIRED subfields. */
const SCHEME_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  apiKeySecurityScheme: ['location', 'name'],
  httpAuthSecurityScheme: ['scheme'],
  oauth2SecurityScheme: ['flows'],
  openIdConnectSecurityScheme: ['openIdConnectUrl'],
  mutualTlsSecurityScheme: [],
};

const undeclaredSecurityScheme: CardRule = {
  id: 'undeclared-security-scheme',
  axis: 'security-declaration-consistency',
  description:
    'Every security requirement must reference a scheme declared in securitySchemes.',
  check(card) {
    const findings: CardFinding[] = [];
    const declared = new Set(
      typeof card.securitySchemes === 'object' && card.securitySchemes !== null
        ? Object.keys(card.securitySchemes)
        : [],
    );

    const checkEntries = (source: unknown[] | undefined, where: string, skill?: string): void => {
      for (const entry of requirementEntries(source)) {
        for (const schemeName of Object.keys(entry)) {
          if (!declared.has(schemeName)) {
            findings.push({
              ruleId: 'undeclared-security-scheme',
              axis: 'security-declaration-consistency',
              severity: 'error',
              field: where,
              ...(skill !== undefined ? { skill } : {}),
              message: `Security requirement references scheme "${schemeName}" which is not declared in securitySchemes.`,
            });
          }
        }
      }
    };

    // Card level: proto-derived spelling first, sample spelling tolerated (ADR-F5).
    checkEntries(card.securityRequirements ?? card.security, 'securityRequirements');
    // Skill level.
    skillsOf(card).forEach((skill, i) => {
      checkEntries(
        skill.securityRequirements,
        `skills[${i}].securityRequirements`,
        skillKey(skill, i),
      );
    });
    return findings;
  },
};

const incompleteSecurityScheme: CardRule = {
  id: 'incomplete-security-scheme',
  axis: 'security-declaration-consistency',
  description:
    'Each declared security scheme must carry a recognized shape with its REQUIRED subfields.',
  check(card) {
    const findings: CardFinding[] = [];
    const schemes =
      typeof card.securitySchemes === 'object' && card.securitySchemes !== null
        ? card.securitySchemes
        : {};

    for (const [name, raw] of Object.entries(schemes)) {
      const at = `securitySchemes.${name}`;
      if (typeof raw !== 'object' || raw === null) {
        findings.push({
          ruleId: 'incomplete-security-scheme',
          axis: 'security-declaration-consistency',
          severity: 'error',
          field: at,
          message: `Security scheme "${name}" is not an object.`,
        });
        continue;
      }
      const scheme = raw as Record<string, unknown>;
      const wrapper = Object.keys(SCHEME_WRAPPERS).find((w) => w in scheme);
      if (wrapper === undefined) {
        // v0.3 / OpenAPI-style flat shape uses a `type` discriminator.
        const legacy = typeof scheme['type'] === 'string';
        findings.push({
          ruleId: 'incomplete-security-scheme',
          axis: 'security-declaration-consistency',
          severity: 'warning',
          field: at,
          message: legacy
            ? `Security scheme "${name}" uses the pre-1.0 flat "type" shape; migrate to the v1.0 oneof wrapper (e.g. "apiKeySecurityScheme").`
            : `Security scheme "${name}" has no recognized v1.0 scheme wrapper (${Object.keys(SCHEME_WRAPPERS).join(', ')}).`,
        });
        continue;
      }
      const body = scheme[wrapper];
      const bodyObj =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      for (const requiredField of SCHEME_WRAPPERS[wrapper] ?? []) {
        if (bodyObj[requiredField] === undefined) {
          findings.push({
            ruleId: 'incomplete-security-scheme',
            axis: 'security-declaration-consistency',
            severity: 'error',
            field: `${at}.${wrapper}.${requiredField}`,
            message: `Security scheme "${name}" (${wrapper}) is missing REQUIRED subfield "${requiredField}".`,
          });
        }
      }
    }
    return findings;
  },
};

const unusedSecurityScheme: CardRule = {
  id: 'unused-security-scheme',
  axis: 'security-declaration-consistency',
  description:
    'Declared security schemes that no requirement references are dead weight.',
  check(card) {
    const declared =
      typeof card.securitySchemes === 'object' && card.securitySchemes !== null
        ? Object.keys(card.securitySchemes)
        : [];
    if (declared.length === 0) return [];

    const referenced = new Set<string>();
    for (const entry of requirementEntries(card.securityRequirements ?? card.security)) {
      for (const k of Object.keys(entry)) referenced.add(k);
    }
    for (const skill of skillsOf(card)) {
      for (const entry of requirementEntries(skill.securityRequirements)) {
        for (const k of Object.keys(entry)) referenced.add(k);
      }
    }

    return declared
      .filter((name) => !referenced.has(name))
      .map(
        (name): CardFinding => ({
          ruleId: 'unused-security-scheme',
          axis: 'security-declaration-consistency',
          severity: 'info',
          field: `securitySchemes.${name}`,
          message: `Security scheme "${name}" is declared but never referenced by any requirement.`,
        }),
      );
  },
};

// ---------------------------------------------------------------------------
// axis: extension-hygiene (capabilities.extensions[], spec §4.4.4)
// ---------------------------------------------------------------------------

function extensionsOf(card: AgentCardJson): { ext: Record<string, unknown>; index: number }[] {
  const list = card.capabilities?.extensions;
  if (!Array.isArray(list)) return [];
  return list.map((ext, index) => ({
    ext: typeof ext === 'object' && ext !== null ? (ext as Record<string, unknown>) : {},
    index,
  }));
}

const extensionInvalidUri: CardRule = {
  id: 'extension-invalid-uri',
  axis: 'extension-hygiene',
  description: 'Every declared extension must carry an absolute URI identifier.',
  check(card) {
    const findings: CardFinding[] = [];
    for (const { ext, index } of extensionsOf(card)) {
      const at = `capabilities.extensions[${index}].uri`;
      const uri = ext['uri'];
      if (!isFilled(uri)) {
        findings.push({
          ruleId: 'extension-invalid-uri',
          axis: 'extension-hygiene',
          severity: 'error',
          field: at,
          message: `Extension ${index} is missing REQUIRED "uri".`,
        });
      } else if (!uri.includes(':')) {
        findings.push({
          ruleId: 'extension-invalid-uri',
          axis: 'extension-hygiene',
          severity: 'warning',
          field: at,
          message: `Extension uri "${uri}" is not an absolute URI.`,
        });
      }
    }
    return findings;
  },
};

const extensionMissingDescription: CardRule = {
  id: 'extension-missing-description',
  axis: 'extension-hygiene',
  description:
    'Extensions should describe themselves — mandatory-to-understand ones especially.',
  check(card) {
    const findings: CardFinding[] = [];
    for (const { ext, index } of extensionsOf(card)) {
      if (!isFilled(ext['description'])) {
        const required = ext['required'] === true;
        findings.push({
          ruleId: 'extension-missing-description',
          axis: 'extension-hygiene',
          severity: required ? 'warning' : 'info',
          field: `capabilities.extensions[${index}].description`,
          message:
            `Extension ${index}${isFilled(ext['uri']) ? ` (${ext['uri'] as string})` : ''} has no description` +
            (required ? ' — clients MUST understand required extensions, so describe it.' : '.'),
        });
      }
    }
    return findings;
  },
};

const requiredExtensionDeclared: CardRule = {
  id: 'required-extension-declared',
  axis: 'extension-hygiene',
  description:
    'Surface required:true extensions — they gate protocol access for unaware clients.',
  check(card) {
    const findings: CardFinding[] = [];
    for (const { ext, index } of extensionsOf(card)) {
      if (ext['required'] === true) {
        findings.push({
          ruleId: 'required-extension-declared',
          axis: 'extension-hygiene',
          severity: 'info',
          field: `capabilities.extensions[${index}]`,
          message:
            `Extension${isFilled(ext['uri']) ? ` "${ext['uri'] as string}"` : ` ${index}`} is required:true — ` +
            'clients that do not declare support will be rejected (ExtensionSupportRequiredError, spec §3.3.4).',
        });
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// axis: interface-hygiene (supportedInterfaces, spec §5.2/§5.7)
// ---------------------------------------------------------------------------

const KNOWN_BINDINGS = new Set(['JSONRPC', 'GRPC', 'HTTP+JSON']);

const noSupportedInterfaces: CardRule = {
  id: 'no-supported-interfaces',
  axis: 'interface-hygiene',
  description: 'supportedInterfaces is REQUIRED and must be non-empty (spec §5.7).',
  check(card) {
    if (!isFilledArray(card.supportedInterfaces)) {
      return [
        {
          ruleId: 'no-supported-interfaces',
          axis: 'interface-hygiene',
          severity: 'error',
          field: 'supportedInterfaces',
          message: 'Card declares no supported interfaces — the agent is unreachable.',
        },
      ];
    }
    return [];
  },
};

const interfaceHygiene: CardRule = {
  id: 'interface-hygiene',
  axis: 'interface-hygiene',
  description:
    'Each interface entry must carry url/protocolBinding/protocolVersion, with an absolute HTTPS url and a known binding.',
  check(card) {
    const findings: CardFinding[] = [];
    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];

    interfaces.forEach((raw, i) => {
      const entry = typeof raw === 'object' && raw !== null ? raw : {};
      const at = (field: string): string => `supportedInterfaces[${i}].${field}`;

      for (const field of ['url', 'protocolBinding', 'protocolVersion'] as const) {
        if (!isFilled(entry[field])) {
          findings.push({
            ruleId: 'interface-hygiene',
            axis: 'interface-hygiene',
            severity: 'error',
            field: at(field),
            message: `Interface ${i} is missing REQUIRED field "${field}".`,
          });
        }
      }

      const url = entry['url'];
      if (isFilled(url)) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        if (parsed === null) {
          findings.push({
            ruleId: 'interface-hygiene',
            axis: 'interface-hygiene',
            severity: 'error',
            field: at('url'),
            message: `Interface ${i} url "${url}" is not an absolute URL.`,
          });
        } else if (parsed.protocol === 'http:') {
          findings.push({
            ruleId: 'interface-hygiene',
            axis: 'interface-hygiene',
            severity: 'warning',
            field: at('url'),
            message: `Interface ${i} url uses http; production interfaces should be HTTPS.`,
          });
        }
      }

      const binding = entry['protocolBinding'];
      if (isFilled(binding) && !KNOWN_BINDINGS.has(binding)) {
        findings.push({
          ruleId: 'unknown-protocol-binding',
          axis: 'interface-hygiene',
          severity: 'warning',
          field: at('protocolBinding'),
          message: `Interface ${i} declares unknown protocolBinding "${binding}" (known: JSONRPC, GRPC, HTTP+JSON). Unknown values are tolerated per spec §5.7 but limit interoperability.`,
        });
      }
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// Rule registry — order is deterministic (insertion order)
// ---------------------------------------------------------------------------

export const ALL_CARD_RULES: readonly CardRule[] = Object.freeze([
  // card-completeness
  cardRequiredFields,
  skillsRequired,
  skillRequiredFields,
  // skill-namespacing
  noMissingSkillDescription,
  vagueSkillName,
  skillPrefixConsistency,
  // skill-selection-overlap
  duplicateSkillIds,
  overlappingSkillNames,
  identicalTagSets,
  // security-declaration-consistency
  undeclaredSecurityScheme,
  incompleteSecurityScheme,
  unusedSecurityScheme,
  // extension-hygiene
  extensionInvalidUri,
  extensionMissingDescription,
  requiredExtensionDeclared,
  // interface-hygiene
  noSupportedInterfaces,
  interfaceHygiene,
]);
