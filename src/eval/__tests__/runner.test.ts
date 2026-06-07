/**
 * Unit tests for src/eval/runner.ts — B-005 acceptance criteria:
 *
 *  1. loadTasks() loads and validates tasks.json
 *  2. EvalRunner.run() produces one TaskTrace per task
 *  3. Each TaskTrace validates against the evals.schema.json schema
 *  4. EvalRunner respects the limit option
 *  5. Tasks are isolated (separate sandbox per task)
 *
 * Uses a MockHarness to avoid live API calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { EvalRunner, loadTasks } from '../runner.js';
import type { Harness, EvalTask } from '../harness.js';
import type { TaskTrace } from '../../types.js';
import type { Toolset } from '../sandbox.js';
import { validateTaskTraceSchema } from '../../report/emit.js';
import type { McpProxy } from '../../connect/proxy.js';
import type { ToolDef } from '../../types.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Mock Harness
// ---------------------------------------------------------------------------

/** Creates a mock harness that returns a valid TaskTrace for any task. */
function makeMockHarness(override: Partial<TaskTrace> = {}): Harness {
  return {
    runTask: vi.fn().mockImplementation(async (task: EvalTask): Promise<TaskTrace> => ({
      taskId: task.taskId,
      multiStep: task.multiStep,
      lowSignal: task.lowSignal,
      pass: true,
      tokenCost: 150,
      chosenTools: task.expectedTools ?? [],
      provenanceEvents: [],
      rubric: { score: 9, round: 1 },
      ...override,
    })),
  };
}

// ---------------------------------------------------------------------------
// Mock proxy
// ---------------------------------------------------------------------------

function makeToolDef(name: string): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    findings: [],
  };
}

function makeMockProxy(toolNames: string[]): McpProxy {
  const toolset: Toolset = {
    listTools: vi.fn().mockResolvedValue(toolNames.map(makeToolDef)),
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
  };

  return {
    listTools: toolset.listTools,
    callTool: toolset.callTool,
    setOverrides: vi.fn(),
    getOverrides: vi.fn().mockReturnValue([]),
    getClient: vi.fn(),
  } as unknown as McpProxy;
}

// ---------------------------------------------------------------------------
// loadTasks
// ---------------------------------------------------------------------------

describe('loadTasks', () => {
  it('loads the real task corpus successfully', async () => {
    const corpusPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'fixtures',
      'tasks',
      'tasks.json',
    );
    const tasks = await loadTasks(corpusPath);

    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThan(0);

    // Validate first task shape
    const first = tasks[0];
    expect(typeof first.taskId).toBe('string');
    expect(typeof first.description).toBe('string');
    expect(typeof first.multiStep).toBe('boolean');
    expect(typeof first.lowSignal).toBe('boolean');
  });

  it('throws on a non-existent file', async () => {
    await expect(loadTasks('/nonexistent/tasks.json')).rejects.toThrow(
      /could not read task corpus/,
    );
  });

  it('throws when the file is not an array', async () => {
    // Write a temp file with an object instead of array
    const tmp = join(__dirname, '.tmp-tasks-object.json');
    const { writeFile, unlink } = await import('node:fs/promises');
    await writeFile(tmp, JSON.stringify({ notAnArray: true }), 'utf8');
    try {
      await expect(loadTasks(tmp)).rejects.toThrow(/must be a JSON array/);
    } finally {
      await unlink(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// EvalRunner
// ---------------------------------------------------------------------------

describe('EvalRunner.run', () => {
  const tasks: EvalTask[] = [
    {
      taskId: 'task-a',
      description: 'Do A',
      multiStep: false,
      lowSignal: true,
      expectedTools: ['search'],
    },
    {
      taskId: 'task-b',
      description: 'Do B',
      multiStep: true,
      lowSignal: false,
      expectedTools: ['process', 'get'],
    },
  ];

  it('returns one trace per task', async () => {
    const runner = new EvalRunner(makeMockHarness());
    const proxy = makeMockProxy(['search', 'process', 'get']);

    const traces = await runner.run(tasks, proxy);

    expect(traces).toHaveLength(2);
    expect(traces[0].taskId).toBe('task-a');
    expect(traces[1].taskId).toBe('task-b');
  });

  it('each trace validates against evals.schema.json', async () => {
    const runner = new EvalRunner(makeMockHarness());
    const proxy = makeMockProxy(['search', 'process', 'get']);

    const traces = await runner.run(tasks, proxy);

    for (const trace of traces) {
      const result = validateTaskTraceSchema(trace);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it('respects the limit option', async () => {
    const runner = new EvalRunner(makeMockHarness());
    const proxy = makeMockProxy(['search']);

    const traces = await runner.run(tasks, proxy, { limit: 1 });

    expect(traces).toHaveLength(1);
    expect(traces[0].taskId).toBe('task-a');
  });

  it('creates a fresh sandbox per task', async () => {
    const harnessRunTask = vi.fn().mockImplementation(
      async (task: EvalTask): Promise<TaskTrace> => ({
        taskId: task.taskId,
        multiStep: task.multiStep,
        lowSignal: task.lowSignal,
        pass: true,
        tokenCost: 0,
        chosenTools: [],
        provenanceEvents: [],
        rubric: { score: 5, round: 1 },
      }),
    );
    const harness: Harness = { runTask: harnessRunTask };
    const proxy = makeMockProxy(['search']);

    await new EvalRunner(harness).run(tasks, proxy);

    // Each call should receive a different sandbox instance
    expect(harnessRunTask).toHaveBeenCalledTimes(2);
    const [, , sandbox1] = harnessRunTask.mock.calls[0] as unknown[];
    const [, , sandbox2] = harnessRunTask.mock.calls[1] as unknown[];
    expect(sandbox1).not.toBe(sandbox2);
  });

  it('passes traces that have correct TaskTrace shape', async () => {
    const runner = new EvalRunner(makeMockHarness({
      provenanceEvents: [
        { type: 'fabricated', tool: 'get', param: 'id', value: 'note-999' },
      ],
    }));
    const proxy = makeMockProxy(['search', 'get']);

    const traces = await runner.run(tasks.slice(0, 1), proxy);

    const trace = traces[0];
    expect(trace.provenanceEvents[0].type).toBe('fabricated');

    // Validate against schema
    const result = validateTaskTraceSchema(trace);
    expect(result.valid).toBe(true);
  });
});
