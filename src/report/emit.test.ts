/**
 * Tests for the artifact emitter (B-004).
 *
 * Verifies that emitted compat.json and evals.jsonl validate against their
 * respective JSON Schemas, and that the validation helpers correctly accept/
 * reject conforming/non-conforming data.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import type { Scorecard, TaskTrace } from '../types.js';
import {
  emitCompat,
  emitEvals,
  validateScorecardSchema,
  validateTaskTraceSchema,
} from './emit.js';

// ---------------------------------------------------------------------------
// validateScorecardSchema
// ---------------------------------------------------------------------------

describe('validateScorecardSchema', () => {
  it('accepts a minimal valid scorecard', () => {
    const result = validateScorecardSchema(makeSampleScorecard());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a scorecard with evalScore and variance', () => {
    const sc = makeSampleScorecard();
    sc.aggregate.evalScore = { mean: 7.2, stdev: 0.8, n: 5 };
    sc.axes['error-helpfulness'].variance = 1.2;
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(true);
  });

  it('rejects a score above 10', () => {
    const sc = makeSampleScorecard();
    (sc.axes.namespacing as unknown as Record<string, unknown>)['score'] = 11;
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a score below 1', () => {
    const sc = makeSampleScorecard();
    (sc.axes.namespacing as unknown as Record<string, unknown>)['score'] = 0;
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(false);
  });

  it('rejects a scorecard missing a required axis', () => {
    const sc = makeSampleScorecard();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (sc.axes as unknown as Record<string, unknown>)['output-leanness'];
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(false);
  });

  it('rejects a scorecard with an unknown transport', () => {
    const sc = makeSampleScorecard();
    (sc.server as unknown as Record<string, unknown>)['transport'] = 'grpc';
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(false);
  });

  it('rejects a scorecard with an invalid lineage value', () => {
    const sc = makeSampleScorecard();
    (sc.axes.namespacing as unknown as Record<string, unknown>)['lineage'] = 'bad-lineage';
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(false);
  });

  it('rejects a scorecard missing schemaVersion', () => {
    const sc = makeSampleScorecard() as unknown as Record<string, unknown>;
    delete sc['schemaVersion'];
    const result = validateScorecardSchema(sc);
    expect(result.valid).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateScorecardSchema(null).valid).toBe(false);
    expect(validateScorecardSchema('string').valid).toBe(false);
    expect(validateScorecardSchema(42).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateTaskTraceSchema
// ---------------------------------------------------------------------------

describe('validateTaskTraceSchema', () => {
  it('accepts a minimal valid trace', () => {
    const result = validateTaskTraceSchema(makeSampleTrace());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a trace with provenance events', () => {
    const t = makeSampleTrace();
    t.provenanceEvents.push({
      type: 'fabricated',
      tool: 'search_nodes',
      param: 'query',
      value: 'unknown-thing',
    });
    const result = validateTaskTraceSchema(t);
    expect(result.valid).toBe(true);
  });

  it('rejects a trace missing taskId', () => {
    const t = makeSampleTrace() as unknown as Record<string, unknown>;
    delete t['taskId'];
    const result = validateTaskTraceSchema(t);
    expect(result.valid).toBe(false);
  });

  it('rejects a trace with rubric score > 10', () => {
    const t = makeSampleTrace();
    (t.rubric as unknown as Record<string, unknown>)['score'] = 11;
    const result = validateTaskTraceSchema(t);
    expect(result.valid).toBe(false);
  });

  it('rejects a trace with negative tokenCost', () => {
    const t = makeSampleTrace();
    (t as unknown as Record<string, unknown>)['tokenCost'] = -1;
    const result = validateTaskTraceSchema(t);
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown provenance type', () => {
    const t = makeSampleTrace();
    t.provenanceEvents.push({
      type: 'unknown' as 'fabricated',
      tool: 'x',
      param: 'y',
    });
    const result = validateTaskTraceSchema(t);
    expect(result.valid).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateTaskTraceSchema(null).valid).toBe(false);
    expect(validateTaskTraceSchema([]).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitCompat
// ---------------------------------------------------------------------------

describe('emitCompat', () => {
  it('writes compat.json that round-trips and validates', async () => {
    const sc = makeSampleScorecard();
    const path = tmpPath('compat', 'json');
    await emitCompat(sc, path);

    const raw = await readFile(path, 'utf8');
    // Must be valid JSON
    const parsed = JSON.parse(raw);
    // Must validate against schema
    const result = validateScorecardSchema(parsed);
    expect(result.valid).toBe(true);
  });

  it('output ends with a newline', async () => {
    const path = tmpPath('compat-nl', 'json');
    await emitCompat(makeSampleScorecard(), path);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('throws for an invalid scorecard', async () => {
    const sc = makeSampleScorecard();
    (sc.axes.namespacing as unknown as Record<string, unknown>)['score'] = 0;
    const path = tmpPath('compat-bad', 'json');
    await expect(emitCompat(sc, path)).rejects.toThrow(/compat\.schema\.json/);
  });
});

// ---------------------------------------------------------------------------
// emitEvals
// ---------------------------------------------------------------------------

describe('emitEvals', () => {
  it('writes evals.jsonl with one line per trace, all validating', async () => {
    const traces = [makeSampleTrace('t1'), makeSampleTrace('t2')];
    const path = tmpPath('evals', 'jsonl');
    await emitEvals(traces, path);

    const raw = await readFile(path, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const obj = JSON.parse(line) as unknown;
      const result = validateTaskTraceSchema(obj);
      expect(result.valid).toBe(true);
    }
  });

  it('output is newline-terminated', async () => {
    const path = tmpPath('evals-nl', 'jsonl');
    await emitEvals([makeSampleTrace()], path);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('handles an empty trace list — writes empty file', async () => {
    const path = tmpPath('evals-empty', 'jsonl');
    await emitEvals([], path);
    const raw = await readFile(path, 'utf8');
    expect(raw).toBe('');
  });

  it('throws for an invalid trace (before writing any)', async () => {
    const bad = makeSampleTrace('bad');
    (bad.rubric as unknown as Record<string, unknown>)['score'] = 99;
    const path = tmpPath('evals-bad', 'jsonl');
    await expect(emitEvals([bad], path)).rejects.toThrow(/evals\.schema\.json/);
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function tmpPath(name: string, ext: string): string {
  return join(tmpdir(), `mcp-fit-${name}-${Date.now()}.${ext}`);
}

function makeSampleScorecard(): Scorecard {
  return {
    schemaVersion: '1.0.0',
    server: { name: 'test-server', version: '1.0.0', transport: 'stdio' },
    axes: {
      namespacing: {
        score: 8,
        lineage: 'tool-choice',
        kind: 'deterministic',
        findings: [],
      },
      'tool-selection-confusion': {
        score: 6,
        lineage: 'tool-choice',
        kind: 'deterministic',
        findings: [
          {
            axis: 'tool-selection-confusion',
            severity: 'warning',
            message: 'search_nodes and get_node descriptions overlap — tool selection is ambiguous',
            tool: 'search_nodes',
          },
        ],
      },
      'param-strictness': {
        score: 7,
        lineage: 'call-signature',
        kind: 'deterministic',
        findings: [],
      },
      'output-leanness': {
        score: 4,
        lineage: 'output-contract',
        kind: 'deterministic',
        findings: [
          {
            axis: 'output-leanness',
            severity: 'error',
            message: 'Output is unstructured prose — no typed schema',
            tool: 'get_node',
          },
        ],
      },
      'error-helpfulness': {
        score: 5,
        lineage: 'provider-only',
        kind: 'eval',
        findings: [],
        variance: 0.5,
      },
    },
    aggregate: {
      lintScore: 6.25,
      weighted: 5.6,
    },
    tools: [
      {
        name: 'search_nodes',
        findings: [
          {
            axis: 'tool-selection-confusion',
            severity: 'warning',
            message: 'search_nodes and get_node descriptions overlap — tool selection is ambiguous',
            tool: 'search_nodes',
          },
        ],
      },
      {
        name: 'get_node',
        findings: [
          {
            axis: 'output-leanness',
            severity: 'error',
            message: 'Output is unstructured prose — no typed schema',
            tool: 'get_node',
          },
        ],
      },
    ],
  };
}

function makeSampleTrace(taskId = 'task-001'): TaskTrace {
  return {
    taskId,
    multiStep: true,
    lowSignal: false,
    pass: true,
    tokenCost: 450,
    chosenTools: ['search_nodes', 'get_node'],
    provenanceEvents: [
      { type: 'traced', tool: 'get_node', param: 'nodeName', value: 'HttpRequest' },
    ],
    rubric: { score: 8, round: 2 },
  };
}
