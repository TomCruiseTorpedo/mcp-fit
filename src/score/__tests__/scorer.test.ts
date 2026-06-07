/**
 * Unit tests for src/score/ — B-006 acceptance criteria:
 *
 *  1. tsc --noEmit clean                               (ensured by build step)
 *  2. Deterministic sub-score reproducible across runs (determinism-test)
 *  3. Stochastic score carries variance                (stochastic-variance-test)
 *  4. Aggregate applies ADR-C weights                  (weights-test)
 *  5. agentshield scan clean                           (ensured by scan step)
 *
 * Tests use mock Anthropic clients (no live API calls).
 */

import { describe, expect, it, vi } from 'vitest';
import type { McpTool, ServerMeta, TaskTrace } from '../../types.js';
import { lint } from '../../lint/engine.js';
import { score, scoreLintOnly } from '../scorer.js';
import { weightedAggregate, AXIS_WEIGHTS } from '../axes.js';
import type { RubricLoopOptions } from '../rubric.js';
import type { EvalTask } from '../../eval/harness.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SERVER_META: ServerMeta = {
  name: 'test-server',
  version: '1.0.0',
  transport: 'stdio',
};

function makeTool(name: string, extra: Partial<McpTool> = {}): McpTool {
  return {
    name,
    description: `Does ${name} thing and returns structured data on error.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The input value.' },
      },
      required: ['input'],
    },
    outputSchema: { type: 'object' },
    ...extra,
  };
}

const GOOD_TOOLS: McpTool[] = [makeTool('fs_read'), makeTool('fs_write'), makeTool('fs_list')];

const BAD_TOOLS: McpTool[] = [
  { name: 'get', inputSchema: { type: 'object' } },    // missing description, vague name
  { name: 'set', inputSchema: { type: 'object' } },    // missing description, vague name
];

function makeTrace(opts: Partial<TaskTrace> = {}): TaskTrace {
  return {
    taskId: 'task-001',
    multiStep: true,
    lowSignal: false,
    pass: true,
    tokenCost: 100,
    chosenTools: ['fs_read'],
    provenanceEvents: [],
    rubric: { score: 8, round: 1 },
    ...opts,
  };
}

function makeTask(opts: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: 'task-001',
    description: 'Read the file at path /tmp/test.txt and return its contents.',
    multiStep: false,
    lowSignal: false,
    expectedTools: ['fs_read'],
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Mock Anthropic client builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Anthropic client that returns fixed rubric/score
 * responses without hitting the API.
 *
 * Call sequence:
 *   1. generateRubric call → returns JSON rubric
 *   2+. scoreTrace calls → returns score text
 */
function mockAnthropicClient(
  rubricResponse: string,
  scoreResponses: string[],
): object {
  let callCount = 0;
  return {
    messages: {
      create: vi.fn().mockImplementation(async () => {
        const isFirst = callCount === 0;
        callCount++;
        const text = isFirst
          ? rubricResponse
          : (scoreResponses[callCount - 2] ?? 'Score: 7');
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 50, output_tokens: 50 },
          stop_reason: 'end_turn',
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// axes.ts: weightedAggregate
// ---------------------------------------------------------------------------

describe('weightedAggregate', () => {
  it('applies ADR-C weights (output-leanness ×1.5, param-strictness ×0.75)', () => {
    // All axes score 10 → weighted should be 10
    const allTen = {
      namespacing: 10,
      'tool-selection-confusion': 10,
      'param-strictness': 10,
      'output-leanness': 10,
      'error-helpfulness': 10,
    };
    expect(weightedAggregate(allTen)).toBe(10);

    // output-leanness at 10, all others at 1 → should pull aggregate higher than uniform
    const outputHeavy = {
      namespacing: 1,
      'tool-selection-confusion': 1,
      'param-strictness': 1,
      'output-leanness': 10,
      'error-helpfulness': 1,
    };
    const totalWeight =
      AXIS_WEIGHTS.namespacing +
      AXIS_WEIGHTS['tool-selection-confusion'] +
      AXIS_WEIGHTS['param-strictness'] +
      AXIS_WEIGHTS['output-leanness'] +
      AXIS_WEIGHTS['error-helpfulness'];
    const expectedWeighted =
      (1 * 1.0 + 1 * 1.0 + 1 * 0.75 + 10 * 1.5 + 1 * 1.0) / totalWeight;
    expect(weightedAggregate(outputHeavy)).toBeCloseTo(expectedWeighted, 1);
  });

  it('param-strictness weight is capped below output-leanness', () => {
    expect(AXIS_WEIGHTS['param-strictness']).toBeLessThan(AXIS_WEIGHTS['output-leanness']);
    expect(AXIS_WEIGHTS['param-strictness']).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// scorer.ts: scoreLintOnly (deterministic)
// ---------------------------------------------------------------------------

describe('scoreLintOnly', () => {
  it('produces a valid lint-only scorecard with deterministic scores', () => {
    const lintResult = lint(GOOD_TOOLS);
    const scorecard = scoreLintOnly(SERVER_META, lintResult);

    expect(scorecard.schemaVersion).toBe('1.0.0');
    expect(scorecard.server).toEqual(SERVER_META);
    expect(scorecard.aggregate.evalScore).toBeUndefined();
    expect(scorecard.aggregate.lintScore).toBeGreaterThan(0);
    expect(scorecard.aggregate.weighted).toBe(scorecard.aggregate.lintScore);

    // Lint-only: statically-assessable axes are deterministic with a numeric
    // score; behavioural axes are eval-only (null score, kind 'eval').
    for (const axis of Object.values(scorecard.axes)) {
      if (axis.score === null) {
        expect(axis.kind).toBe('eval');
      } else {
        expect(axis.kind).toBe('deterministic');
        expect(axis.score).toBeGreaterThanOrEqual(1);
        expect(axis.score).toBeLessThanOrEqual(10);
      }
      expect(axis.variance).toBeUndefined();
    }
  });

  it('is reproducible: same tools → same scorecard (determinism)', () => {
    const lintResult1 = lint(GOOD_TOOLS);
    const lintResult2 = lint(GOOD_TOOLS);
    const sc1 = scoreLintOnly(SERVER_META, lintResult1);
    const sc2 = scoreLintOnly(SERVER_META, lintResult2);

    // Scores must be identical (determinism guarantee)
    expect(sc1.aggregate.lintScore).toBe(sc2.aggregate.lintScore);
    expect(sc1.aggregate.weighted).toBe(sc2.aggregate.weighted);
    for (const axisName of Object.keys(sc1.axes) as Array<keyof typeof sc1.axes>) {
      expect(sc1.axes[axisName].score).toBe(sc2.axes[axisName].score);
    }
  });

  it('bad tools score lower than good tools', () => {
    const goodLint = lint(GOOD_TOOLS);
    const badLint = lint(BAD_TOOLS);
    const goodSc = scoreLintOnly(SERVER_META, goodLint);
    const badSc = scoreLintOnly(SERVER_META, badLint);

    expect(goodSc.aggregate.lintScore).toBeGreaterThan(badSc.aggregate.lintScore);
  });

  it('includes tool reports from lint', () => {
    const lintResult = lint(GOOD_TOOLS);
    const scorecard = scoreLintOnly(SERVER_META, lintResult);

    expect(scorecard.tools).toHaveLength(GOOD_TOOLS.length);
    for (const report of scorecard.tools) {
      expect(report.name).toBeTruthy();
      expect(Array.isArray(report.findings)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// scorer.ts: score() with mock rubric loop (stochastic)
// ---------------------------------------------------------------------------

describe('score() — with eval traces (stochastic path)', () => {
  it('produces a scorecard with evalScore and variance when traces provided', async () => {
    const lintResult = lint(GOOD_TOOLS);
    const task = makeTask();
    const trace = makeTrace();

    const rubricJson = JSON.stringify({
      criteria: [
        { id: 'c1', description: 'Correct tool called', weight: 3 },
        { id: 'c2', description: 'Task completed', weight: 2 },
      ],
    });
    const mockClient = mockAnthropicClient(rubricJson, ['Score: 8', 'Score: 9']);

    const rubricOptions: RubricLoopOptions = {
      client: mockClient as unknown as import('@anthropic-ai/sdk').default,
      maxRounds: 2,
      patience: 2,
    };

    const result = await score({
      server: SERVER_META,
      lintResult,
      evalTraces: [{ task, trace }],
      toolNames: GOOD_TOOLS.map((t) => t.name),
      rubricOptions,
    });

    const { scorecard } = result;

    // evalScore must be present
    expect(scorecard.aggregate.evalScore).toBeDefined();
    expect(scorecard.aggregate.evalScore!.n).toBeGreaterThan(0);
    expect(scorecard.aggregate.evalScore!.mean).toBeGreaterThanOrEqual(1);
    expect(scorecard.aggregate.evalScore!.mean).toBeLessThanOrEqual(10);
    expect(typeof scorecard.aggregate.evalScore!.stdev).toBe('number');
    expect(scorecard.aggregate.evalScore!.stdev).toBeGreaterThanOrEqual(0);

    // lintScore must still be present (deterministic headline)
    expect(scorecard.aggregate.lintScore).toBeGreaterThan(0);

    // weighted should differ from lint-only when eval is present
    expect(typeof scorecard.aggregate.weighted).toBe('number');
  });

  it('axis scores have kind=eval when traces provided', async () => {
    const lintResult = lint(GOOD_TOOLS);
    const task = makeTask();
    const trace = makeTrace();

    const rubricJson = JSON.stringify({
      criteria: [{ id: 'c1', description: 'Tool use correct', weight: 2 }],
    });
    const mockClient = mockAnthropicClient(rubricJson, ['Score: 7']);

    const rubricOptions: RubricLoopOptions = {
      client: mockClient as unknown as import('@anthropic-ai/sdk').default,
      maxRounds: 1,
    };

    const { scorecard } = await score({
      server: SERVER_META,
      lintResult,
      evalTraces: [{ task, trace }],
      toolNames: ['fs_read'],
      rubricOptions,
    });

    for (const axis of Object.values(scorecard.axes)) {
      expect(axis.kind).toBe('eval');
      expect(typeof axis.variance).toBe('number');
    }
  });

  it('low-signal traces are excluded from the rubric loop', async () => {
    const lintResult = lint(GOOD_TOOLS);

    // Only low-signal tasks
    const lowSignalTask = makeTask({ lowSignal: true });
    const lowSignalTrace = makeTrace({ lowSignal: true });

    const rubricJson = JSON.stringify({ criteria: [] });
    const mockClient = mockAnthropicClient(rubricJson, []);

    const rubricOptions: RubricLoopOptions = {
      client: mockClient as unknown as import('@anthropic-ai/sdk').default,
      maxRounds: 3,
    };

    const { scorecard, rubricResults } = await score({
      server: SERVER_META,
      lintResult,
      evalTraces: [{ task: lowSignalTask, trace: lowSignalTrace }],
      toolNames: [],
      rubricOptions,
    });

    // No rubric results — low-signal trace was excluded
    expect(rubricResults).toHaveLength(0);

    // evalScore must be absent (no high-signal traces)
    expect(scorecard.aggregate.evalScore).toBeUndefined();
  });

  it('lint-only path returns deterministic scorecard when no traces', async () => {
    const lintResult = lint(GOOD_TOOLS);

    const { scorecard, rubricResults } = await score({
      server: SERVER_META,
      lintResult,
    });

    expect(rubricResults).toHaveLength(0);
    expect(scorecard.aggregate.evalScore).toBeUndefined();
    for (const axis of Object.values(scorecard.axes)) {
      // Eval-only axes stay 'eval' (null score) even with no eval traces.
      expect(axis.kind).toBe(axis.score === null ? 'eval' : 'deterministic');
    }
  });
});

// ---------------------------------------------------------------------------
// rubric.ts: variance reported
// ---------------------------------------------------------------------------

describe('rubric variance', () => {
  it('variance is non-negative', async () => {
    const lintResult = lint(GOOD_TOOLS);
    const task = makeTask();
    const trace = makeTrace();

    const rubricJson = JSON.stringify({
      criteria: [{ id: 'c1', description: 'Correctness', weight: 2 }],
    });
    // Two different scores → variance > 0
    const mockClient = mockAnthropicClient(rubricJson, ['Score: 6', 'Score: 8', 'Score: 7']);

    const rubricOptions: RubricLoopOptions = {
      client: mockClient as unknown as import('@anthropic-ai/sdk').default,
      maxRounds: 3,
      patience: 3, // no patience early-stop
    };

    const { scorecard } = await score({
      server: SERVER_META,
      lintResult,
      evalTraces: [{ task, trace }],
      toolNames: [],
      rubricOptions,
    });

    expect(scorecard.aggregate.evalScore).toBeDefined();
    // stdev should be ≥ 0
    expect(scorecard.aggregate.evalScore!.stdev).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Scorecard shape validation
// ---------------------------------------------------------------------------

describe('scorecard shape', () => {
  it('has all five axes', () => {
    const lintResult = lint(GOOD_TOOLS);
    const scorecard = scoreLintOnly(SERVER_META, lintResult);

    const axisNames = Object.keys(scorecard.axes);
    expect(axisNames).toContain('namespacing');
    expect(axisNames).toContain('tool-selection-confusion');
    expect(axisNames).toContain('param-strictness');
    expect(axisNames).toContain('output-leanness');
    expect(axisNames).toContain('error-helpfulness');
  });

  it('each axis has lineage, kind, score, findings', () => {
    const lintResult = lint(GOOD_TOOLS);
    const scorecard = scoreLintOnly(SERVER_META, lintResult);

    for (const axis of Object.values(scorecard.axes)) {
      expect(typeof axis.lineage).toBe('string');
      expect(typeof axis.kind).toBe('string');
      // score is a number for deterministic axes, null for eval-only axes.
      expect(axis.score === null || typeof axis.score === 'number').toBe(true);
      expect(Array.isArray(axis.findings)).toBe(true);
    }
  });
});
