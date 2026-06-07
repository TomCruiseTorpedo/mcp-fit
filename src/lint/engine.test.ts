/**
 * Unit tests for src/lint/engine.ts — B-002 acceptance criteria:
 *
 *  1. tsc --noEmit clean                               (ensured by build step)
 *  2. Determinism: same input twice → identical output  (determinism-test)
 *  3. Missing-description finding green                 (missing-desc-test)
 *  4. Missing required-param description finding green  (missing-param-desc-test)
 *  5. agentshield scan clean                           (ensured by scan step)
 */

import { describe, expect, it } from 'vitest';
import { lint } from './engine.js';
import type { McpTool, AxisName } from '../types.js';
import { DETERMINISTIC_AXES } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalTool(name: string, extra: Partial<McpTool> = {}): McpTool {
  return { name, inputSchema: { type: 'object' }, ...extra };
}

function wellDescribedTool(name: string): McpTool {
  return {
    name,
    description: 'Reads a file from disk and returns the raw bytes on error.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
      },
      required: ['path'],
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } } },
  };
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical JSON for the same input called twice', () => {
    const tools: McpTool[] = [
      wellDescribedTool('read_file'),
      wellDescribedTool('write_file'),
    ];
    const r1 = lint(tools);
    const r2 = lint(tools);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('produces identical JSON for a maximally-bad input called twice', () => {
    const tools: McpTool[] = [
      minimalTool('a'),
      minimalTool('bb'),
    ];
    const r1 = lint(tools);
    const r2 = lint(tools);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('output is identical regardless of input array order', () => {
    const t1 = wellDescribedTool('alpha_read');
    const t2 = wellDescribedTool('beta_write');
    const r1 = lint([t1, t2]);
    const r2 = lint([t2, t1]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---------------------------------------------------------------------------
// Missing-description rule (namespacing axis)
// ---------------------------------------------------------------------------

describe('missing tool description → namespacing finding', () => {
  it('raises no-missing-tool-description when description is absent', () => {
    const result = lint([minimalTool('undescribed_tool')]);
    const findings = result.axisScores.namespacing.findings;
    expect(findings.some(f => f.ruleId === 'no-missing-tool-description')).toBe(true);
    expect(findings.some(f => f.tool === 'undescribed_tool')).toBe(true);
  });

  it('raises no-missing-tool-description when description is empty string', () => {
    const result = lint([minimalTool('empty_desc_tool', { description: '   ' })]);
    const findings = result.axisScores.namespacing.findings;
    expect(findings.some(f => f.ruleId === 'no-missing-tool-description')).toBe(true);
  });

  it('does NOT raise no-missing-tool-description for a described tool', () => {
    const result = lint([wellDescribedTool('good_tool')]);
    const findings = result.axisScores.namespacing.findings;
    expect(findings.some(f => f.ruleId === 'no-missing-tool-description')).toBe(false);
  });

  it('finding message names the offending tool', () => {
    const result = lint([minimalTool('my_unnamed_tool')]);
    const f = result.axisScores.namespacing.findings.find(
      x => x.ruleId === 'no-missing-tool-description',
    );
    expect(f).toBeDefined();
    expect(f?.message).toContain('my_unnamed_tool');
  });
});

// ---------------------------------------------------------------------------
// Missing required-param description rule (param-strictness axis)
// ---------------------------------------------------------------------------

describe('missing required-param description → param-strictness finding', () => {
  it('raises no-required-param-description for an undescribed required param', () => {
    const tool: McpTool = {
      name: 'search_files',
      description: 'Search files; returns null on error.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }, // ← no description
        },
        required: ['query'],
      },
    };
    const result = lint([tool]);
    const findings = result.axisScores['param-strictness'].findings;
    expect(findings.some(f => f.ruleId === 'no-required-param-description')).toBe(true);
    expect(findings.some(f => f.param === 'query')).toBe(true);
    expect(findings.some(f => f.tool === 'search_files')).toBe(true);
  });

  it('names both tool and param in the finding message', () => {
    const tool: McpTool = {
      name: 'my_tool',
      description: 'Does something; throws on invalid input.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
    };
    const result = lint([tool]);
    const f = result.axisScores['param-strictness'].findings.find(
      x => x.ruleId === 'no-required-param-description',
    );
    expect(f?.message).toContain('my_tool');
    expect(f?.message).toContain('target');
  });

  it('does NOT raise no-required-param-description for a described required param', () => {
    const tool: McpTool = {
      name: 'good_tool',
      description: 'Does something; fails on not found.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to the resource.' } },
        required: ['path'],
      },
    };
    const result = lint([tool]);
    const findings = result.axisScores['param-strictness'].findings;
    expect(findings.some(f => f.ruleId === 'no-required-param-description')).toBe(false);
  });

  it('raises a finding for each undescribed required param individually', () => {
    const tool: McpTool = {
      name: 'multi_param_tool',
      description: 'Multi-param tool; throws on invalid args.',
      inputSchema: {
        type: 'object',
        properties: {
          alpha: { type: 'string' }, // no description
          beta: { type: 'number' },  // no description
          gamma: { type: 'boolean', description: 'A described param.' }, // OK
        },
        required: ['alpha', 'beta', 'gamma'],
      },
    };
    const result = lint([tool]);
    const findings = result.axisScores['param-strictness'].findings.filter(
      f => f.ruleId === 'no-required-param-description',
    );
    expect(findings.some(f => f.param === 'alpha')).toBe(true);
    expect(findings.some(f => f.param === 'beta')).toBe(true);
    expect(findings.some(f => f.param === 'gamma')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Score structure
// ---------------------------------------------------------------------------

describe('score structure', () => {
  it('emits scores for all 5 axes', () => {
    const result = lint([wellDescribedTool('x_tool')]);
    expect(Object.keys(result.axisScores)).toEqual(
      expect.arrayContaining([
        'namespacing',
        'tool-selection-confusion',
        'param-strictness',
        'output-leanness',
        'error-helpfulness',
      ]),
    );
  });

  it('all axis scores are in [1, 10]', () => {
    // Deliberately bad tools to stress the floor
    const bad: McpTool[] = Array.from({ length: 3 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: {
        type: 'object' as const,
        properties: { p1: {}, p2: {} },
        required: ['p1', 'p2'],
      },
    }));
    const result = lint(bad);
    for (const axisScore of Object.values(result.axisScores)) {
      if (axisScore.score === null) continue; // eval-only axis — no deterministic score
      expect(axisScore.score).toBeGreaterThanOrEqual(1);
      expect(axisScore.score).toBeLessThanOrEqual(10);
    }
  });

  it('aggregate lintScore is in [1, 10]', () => {
    const result = lint([minimalTool('x')]);
    expect(result.aggregate.lintScore).toBeGreaterThanOrEqual(1);
    expect(result.aggregate.lintScore).toBeLessThanOrEqual(10);
  });

  it('only statically-assessable axes are deterministic; behavioural axes are eval-only', () => {
    const result = lint([minimalTool('t')]);
    for (const [name, axis] of Object.entries(result.axisScores)) {
      if (DETERMINISTIC_AXES.has(name as AxisName)) {
        expect(axis.kind).toBe('deterministic');
        expect(typeof axis.score).toBe('number');
      } else {
        expect(axis.kind).toBe('eval');
        expect(axis.score).toBeNull();
      }
    }
    // The behavioural axes static lint cannot grade carry a null deterministic score:
    expect(result.axisScores['output-leanness'].score).toBeNull();
    expect(result.axisScores['error-helpfulness'].score).toBeNull();
    expect(result.axisScores['tool-selection-confusion'].score).toBeNull();
    expect(result.axisScores['param-strictness'].score).not.toBeNull();
  });

  it('every tool-level finding references a tool present in the input', () => {
    const tools = [wellDescribedTool('alpha_op'), minimalTool('beta_op')];
    const names = new Set(tools.map(t => t.name));
    const result = lint(tools);
    for (const report of result.tools) {
      for (const finding of report.findings) {
        expect(names.has(finding.tool ?? '')).toBe(true);
      }
    }
  });

  it('lint([]) returns valid empty-tool result without throwing', () => {
    const result = lint([]);
    expect(result.tools).toHaveLength(0);
    expect(result.aggregate.lintScore).toBeGreaterThanOrEqual(1);
    expect(result.aggregate.lintScore).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Per-axis spot-checks
// ---------------------------------------------------------------------------

describe('per-rule spot-checks', () => {
  it('vague-tool-name fires on a single-generic-word tool', () => {
    const result = lint([
      { name: 'get', description: 'Gets something.', inputSchema: { type: 'object' } },
    ]);
    const findings = result.axisScores.namespacing.findings;
    expect(findings.some(f => f.ruleId === 'vague-tool-name')).toBe(true);
  });

  it('prose-output-hint fires on a description with prose signals', () => {
    const tool: McpTool = {
      name: 'explain_code',
      description: 'Returns a detailed explanation of the code logic.',
      inputSchema: { type: 'object' },
    };
    const result = lint([tool]);
    const findings = result.axisScores['output-leanness'].findings;
    expect(findings.some(f => f.ruleId === 'prose-output-hint')).toBe(true);
  });

  it('no-error-docs fires when description has no error mention', () => {
    const tool: McpTool = {
      name: 'happy_path',
      description: 'Reads a file and returns its content as a string.',
      inputSchema: { type: 'object' },
    };
    const result = lint([tool]);
    const findings = result.axisScores['error-helpfulness'].findings;
    expect(findings.some(f => f.ruleId === 'no-error-docs')).toBe(true);
  });

  it('no-error-docs does NOT fire when description mentions error', () => {
    const tool: McpTool = {
      name: 'safe_read',
      description: 'Reads a file; returns null on error.',
      inputSchema: { type: 'object' },
    };
    const result = lint([tool]);
    const findings = result.axisScores['error-helpfulness'].findings;
    expect(findings.some(f => f.ruleId === 'no-error-docs')).toBe(false);
  });

  it('overlapping-tool-names fires for suspiciously similar names', () => {
    const tools: McpTool[] = [
      { name: 'search_files', description: 'Searches files.', inputSchema: { type: 'object' } },
      { name: 'searchfiles',  description: 'Also searches files.', inputSchema: { type: 'object' } },
    ];
    const result = lint(tools);
    const findings = result.axisScores['tool-selection-confusion'].findings;
    expect(findings.some(f => f.ruleId === 'overlapping-tool-names')).toBe(true);
  });
});
