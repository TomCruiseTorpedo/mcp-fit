/**
 * mcp-fit lint rules — B-002
 *
 * Each rule is deterministic: given the same tool list it always produces the
 * same findings. Rules are tagged to the scorecard axis they affect (ADR-C).
 *
 * Rule shape:
 *   id       — stable kebab-case identifier used in Finding.ruleId
 *   axis     — which scorecard axis this rule feeds
 *   check()  — receives the target tool + all tools; returns 0-N findings
 */

import type { AxisName, Finding, McpTool } from '../types.js';

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

export interface Rule {
  readonly id: string;
  readonly axis: AxisName;
  readonly description: string;
  check(tool: McpTool, allTools: readonly McpTool[]): Finding[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Allocate a flat array instead of 2-D for speed; rows reused.
  const row0 = Array.from({ length: n + 1 }, (_, j) => j);
  const row1 = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    row1[0] = i;
    for (let j = 1; j <= n; j++) {
      row1[j] =
        a[i - 1] === b[j - 1]
          ? (row0[j - 1] ?? 0)
          : 1 +
            Math.min(
              row0[j] ?? 0,       // deletion
              row1[j - 1] ?? 0,   // insertion
              row0[j - 1] ?? 0,   // substitution
            );
    }
    row0.splice(0, n + 1, ...row1);
  }
  return row0[n] ?? 0;
}

/** Normalise a tool name for similarity comparisons. */
function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[_\-\s]+/g, '');
}

/** Return true when two tool names are suspiciously similar. */
function areSimilarNames(a: string, b: string): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Close edit distance only when both names are long enough to be meaningful
  return (
    na.length >= 5 &&
    nb.length >= 5 &&
    levenshtein(na, nb) <= 2
  );
}

/** Extract first regex match as a short excerpt for embedding in messages. */
function excerpt(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? m[0].trim().slice(0, 60) : '';
}

// ---------------------------------------------------------------------------
// axis: namespacing
// ---------------------------------------------------------------------------

/**
 * Every tool must have a non-empty description.
 * Spec: "Missing description … raise findings under namespacing."
 */
const noMissingToolDescription: Rule = {
  id: 'no-missing-tool-description',
  axis: 'namespacing',
  description:
    'Every tool must have a non-empty description so agents can identify it.',
  check(tool) {
    if (tool.description === undefined || tool.description.trim().length === 0) {
      return [
        {
          ruleId: 'no-missing-tool-description',
          axis: 'namespacing',
          severity: 'error',
          tool: tool.name,
          message: `Tool "${tool.name}" has no description.`,
        },
      ];
    }
    return [];
  },
};

/**
 * Single-word or dictionary-generic tool names create selection ambiguity.
 */
const vagueToolName: Rule = {
  id: 'vague-tool-name',
  axis: 'namespacing',
  description:
    'Tool names that are too short or domain-generic confuse agent tool selection.',
  check(tool) {
    const GENERIC = new Set([
      'call', 'delete', 'do', 'exec', 'execute', 'fetch', 'get', 'go',
      'list', 'post', 'put', 'read', 'run', 'send', 'set', 'write',
    ]);
    const lower = tool.name.toLowerCase();
    if (GENERIC.has(lower) || tool.name.length <= 2) {
      return [
        {
          ruleId: 'vague-tool-name',
          axis: 'namespacing',
          severity: 'warning',
          tool: tool.name,
          message: `Tool name "${tool.name}" is too generic; prefer a domain-specific descriptive name.`,
        },
      ];
    }
    return [];
  },
};

/**
 * When most tools share a naming prefix, outliers are harder to discover.
 * Only fires when ≥ 3 tools exist and one prefix covers > 50 % of them.
 */
const prefixConsistency: Rule = {
  id: 'prefix-consistency',
  axis: 'namespacing',
  description:
    'Tools in the same server should use a consistent naming prefix to aid discovery.',
  check(tool, allTools) {
    if (allTools.length < 3) return [];

    // A prefix is the lowercase segment before the first separator (_, -, uppercase).
    const getPrefix = (name: string): string | null => {
      const m = name.match(/^([a-z][a-z0-9]*)(?:[_\-]|(?=[A-Z]))/);
      return m ? (m[1] ?? null) : null;
    };

    const prefixes = allTools.map(t => getPrefix(t.name)).filter(
      (p): p is string => p !== null,
    );
    if (prefixes.length < 2) return [];

    const freq: Record<string, number> = {};
    for (const p of prefixes) freq[p] = (freq[p] ?? 0) + 1;

    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const [dominant, count] = sorted[0] ?? ['', 0];
    if (count / allTools.length <= 0.5) return [];

    const myPrefix = getPrefix(tool.name);
    if (myPrefix !== dominant) {
      return [
        {
          ruleId: 'prefix-consistency',
          axis: 'namespacing',
          severity: 'warning',
          tool: tool.name,
          message: `Tool "${tool.name}" does not share the dominant prefix "${dominant}_"; consider renaming for consistency.`,
        },
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// axis: tool-selection-confusion
// ---------------------------------------------------------------------------

/**
 * Tools with very similar names risk confusing agent tool selection.
 * Only one finding is emitted per pair (from the lexicographically-later tool)
 * to avoid duplicate noise.
 */
const overlappingToolNames: Rule = {
  id: 'overlapping-tool-names',
  axis: 'tool-selection-confusion',
  description:
    'Tools with very similar names may mislead agent tool selection.',
  check(tool, allTools) {
    const findings: Finding[] = [];
    for (const other of allTools) {
      if (other.name === tool.name) continue;
      // Emit once per pair: only from the lexicographically-larger name
      if (tool.name <= other.name) continue;
      if (areSimilarNames(tool.name, other.name)) {
        findings.push({
          ruleId: 'overlapping-tool-names',
          axis: 'tool-selection-confusion',
          severity: 'warning',
          tool: tool.name,
          message: `Tool "${tool.name}" has a very similar name to "${other.name}"; overlapping names confuse tool selection.`,
        });
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// axis: param-strictness
// ---------------------------------------------------------------------------

/**
 * Every required parameter must have a non-empty description.
 * Spec: "undescribed required params raise findings under param-strictness
 *        naming the tool and param."
 */
const noRequiredParamDescription: Rule = {
  id: 'no-required-param-description',
  axis: 'param-strictness',
  description:
    'Every required parameter must have a non-empty description for unambiguous call signatures.',
  check(tool) {
    const findings: Finding[] = [];
    const { properties = {}, required = [] } = tool.inputSchema;
    for (const paramName of required) {
      const param = properties[paramName];
      if (
        param === undefined ||
        param.description === undefined ||
        param.description.trim().length === 0
      ) {
        findings.push({
          ruleId: 'no-required-param-description',
          axis: 'param-strictness',
          severity: 'error',
          tool: tool.name,
          param: paramName,
          message: `Required parameter "${paramName}" of tool "${tool.name}" has no description.`,
        });
      }
    }
    return findings;
  },
};

/**
 * Parameters without a declared type weaken the call-signature contract.
 */
const noParamType: Rule = {
  id: 'no-param-type',
  axis: 'param-strictness',
  description:
    'Every parameter should declare a JSON Schema type for strict call signatures.',
  check(tool) {
    const findings: Finding[] = [];
    const { properties = {} } = tool.inputSchema;
    for (const [paramName, param] of Object.entries(properties)) {
      if (param.type === undefined) {
        findings.push({
          ruleId: 'no-param-type',
          axis: 'param-strictness',
          severity: 'warning',
          tool: tool.name,
          param: paramName,
          message: `Parameter "${paramName}" of tool "${tool.name}" has no type declaration.`,
        });
      }
    }
    return findings;
  },
};

/**
 * A parameter named "optional" appearing in the required list is misleading.
 */
const optionalRequiredConfusion: Rule = {
  id: 'optional-required-confusion',
  axis: 'param-strictness',
  description:
    'Parameters named "optional" must not appear in the required list.',
  check(tool) {
    const findings: Finding[] = [];
    const { properties = {}, required = [] } = tool.inputSchema;
    const requiredSet = new Set(required);
    for (const paramName of Object.keys(properties)) {
      if (requiredSet.has(paramName) && /optional/i.test(paramName)) {
        findings.push({
          ruleId: 'optional-required-confusion',
          axis: 'param-strictness',
          severity: 'warning',
          tool: tool.name,
          param: paramName,
          message: `Parameter "${paramName}" of tool "${tool.name}" is named "optional" but appears in the required list.`,
        });
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// axis: output-leanness
// ---------------------------------------------------------------------------

/**
 * Descriptions that hint at prose/narrative output predict token bloat.
 * These patterns are conservative: only explicit signals, not vague words.
 */
const PROSE_PATTERNS: ReadonlyArray<RegExp> = [
  /returns?\s+a\s+(detailed|comprehensive|full|complete|lengthy|long)\s+/i,
  /provides?\s+a\s+(detailed|comprehensive|full|complete|lengthy|long)\s+/i,
  /returns?\s+a\s+(description|explanation|summary|overview|narrative)\b/i,
  /outputs?\s+(human.readable|prose|natural.language)\s+/i,
  /returns?\s+a\s+string\s+(that|containing|with|describing)\s+/i,
];

const proseOutputHint: Rule = {
  id: 'prose-output-hint',
  axis: 'output-leanness',
  description:
    'Descriptions hinting at prose/unstructured output predict token bloat.',
  check(tool) {
    if (!tool.description) return [];
    for (const pattern of PROSE_PATTERNS) {
      if (pattern.test(tool.description)) {
        return [
          {
            ruleId: 'prose-output-hint',
            axis: 'output-leanness',
            severity: 'warning',
            tool: tool.name,
            message:
              `Tool "${tool.name}" description hints at prose output` +
              ` ("${excerpt(tool.description, pattern)}"); prefer structured typed values.`,
          },
        ];
      }
    }
    return [];
  },
};

/**
 * A declared outputSchema signals structured output contracts.
 * Absence is not a hard error — many real tools omit it — so this is info-level.
 */
const noOutputSchema: Rule = {
  id: 'no-output-schema',
  axis: 'output-leanness',
  description:
    'Tools should declare outputSchema to communicate structured output contracts.',
  check(tool) {
    if (tool.outputSchema === undefined) {
      return [
        {
          ruleId: 'no-output-schema',
          axis: 'output-leanness',
          severity: 'info',
          tool: tool.name,
          message: `Tool "${tool.name}" does not declare an outputSchema; structured contracts improve token efficiency.`,
        },
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// axis: error-helpfulness
// ---------------------------------------------------------------------------

/**
 * Tool descriptions that never mention errors leave agents without recovery
 * guidance. This is info-level since many tools have implicit-only error paths.
 */
const ERROR_SIGNAL_RE =
  /\b(error|fail|exception|throw|invalid|not\s+found|does\s+not\s+exist|returns?\s+null|undefined)\b/i;

const noErrorDocs: Rule = {
  id: 'no-error-docs',
  axis: 'error-helpfulness',
  description:
    'Tool descriptions should document error cases so agents can plan recovery.',
  check(tool) {
    if (!tool.description) return []; // no-missing-tool-description covers this
    if (!ERROR_SIGNAL_RE.test(tool.description)) {
      return [
        {
          ruleId: 'no-error-docs',
          axis: 'error-helpfulness',
          severity: 'info',
          tool: tool.name,
          message: `Tool "${tool.name}" description does not mention error cases or recovery guidance.`,
        },
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// Rule registry — order is deterministic (insertion order)
// ---------------------------------------------------------------------------

export const ALL_RULES: readonly Rule[] = Object.freeze([
  // namespacing
  noMissingToolDescription,
  vagueToolName,
  prefixConsistency,
  // tool-selection-confusion
  overlappingToolNames,
  // param-strictness
  noRequiredParamDescription,
  noParamType,
  optionalRequiredConfusion,
  // output-leanness
  proseOutputHint,
  noOutputSchema,
  // error-helpfulness
  noErrorDocs,
]);
