/**
 * Unit tests for src/eval/harness.ts — B-005 acceptance criteria:
 *
 *  1. classifyProvenance → 'literal' when value is in task description
 *  2. classifyProvenance → 'traced' when value is in a prior tool return
 *  3. classifyProvenance → 'fabricated' when value is not in either
 *  4. analyzeToolCallProvenance emits provenance:fabricated event correctly
 *  5. computePreliminaryRubric scores correctly
 *  6. ClaudeHarness.runTask with a mock client returns a valid TaskTrace
 *     (including provenance:fabricated when agent fabricates an argument)
 *
 * No live Anthropic API calls. The Anthropic client is injected as a mock.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyProvenance,
  analyzeToolCallProvenance,
  computePreliminaryRubric,
  ClaudeHarness,
} from '../harness.js';
import { Sandbox } from '../sandbox.js';
import type { EvalTask } from '../harness.js';
import type { Toolset } from '../sandbox.js';
import type { ToolDef } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolDef(name: string): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    findings: [],
  };
}

function makeMockToolset(toolNames: string[]): Toolset {
  return {
    listTools: vi.fn().mockResolvedValue(toolNames.map(makeToolDef)),
    callTool: vi.fn().mockResolvedValue({ id: 'note-99', title: 'Result' }),
  };
}

// ---------------------------------------------------------------------------
// classifyProvenance
// ---------------------------------------------------------------------------

describe('classifyProvenance', () => {
  it("returns 'literal' when value appears in task description", () => {
    const type = classifyProvenance('note-1', "Retrieve note with ID 'note-1'", []);
    expect(type).toBe('literal');
  });

  it("returns 'traced' when value appears in a prior tool return", () => {
    const priorReturn = { id: 'note-42', title: 'Found' };
    const type = classifyProvenance('note-42', 'Do something with a note', [priorReturn]);
    expect(type).toBe('traced');
  });

  it("returns 'fabricated' when value appears in neither", () => {
    const type = classifyProvenance('note-999', 'Find the meeting note', [
      { id: 'note-1' },
    ]);
    expect(type).toBe('fabricated');
  });

  it("returns 'literal' for numeric value found in task description", () => {
    // 42 is a string in taskDesc
    const type = classifyProvenance(42, 'Process item 42', []);
    // JSON.stringify(42) === '42'; taskDesc.includes('42') === true
    expect(type).toBe('literal');
  });

  it("returns 'fabricated' for empty string", () => {
    // Empty string would match everything — classified as fabricated (no content)
    const type = classifyProvenance('', 'Do something', [{ result: '' }]);
    expect(type).toBe('fabricated');
  });

  it("returns 'traced' for object value found serialised in prior return", () => {
    const prior = { nested: { id: 'abc-123' } };
    const type = classifyProvenance('abc-123', 'Update an item', [prior]);
    expect(type).toBe('traced');
  });
});

// ---------------------------------------------------------------------------
// analyzeToolCallProvenance
// ---------------------------------------------------------------------------

describe('analyzeToolCallProvenance', () => {
  it("emits provenance:fabricated event when argument not in description or returns", () => {
    const events = analyzeToolCallProvenance(
      'get',
      { id: 'note-999' },
      'Find the meeting note about Q1',
      [],
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('fabricated');
    expect(events[0].tool).toBe('get');
    expect(events[0].param).toBe('id');
    expect(events[0].value).toBe('note-999');
  });

  it("emits provenance:literal event when argument is in task description", () => {
    const events = analyzeToolCallProvenance(
      'get',
      { id: 'note-1' },
      "Retrieve the note with ID 'note-1'",
      [],
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('literal');
  });

  it("emits provenance:traced event when argument traces to prior tool return", () => {
    const events = analyzeToolCallProvenance(
      'change',
      { id: 'note-5' },
      'Update a note',
      [{ id: 'note-5', title: 'Old title' }],
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('traced');
  });

  it('emits one event per argument', () => {
    const events = analyzeToolCallProvenance(
      'process',
      { title: 'New Note', content: 'Body', type: 'note' },
      "Create a note titled 'New Note' with type note",
      [],
    );
    // 'title' = 'New Note' → literal (in desc)
    // 'type' = 'note' → literal (in desc)
    // 'content' = 'Body' → fabricated (not in desc "New Note" "type" "note")
    expect(events).toHaveLength(3);
    const titleEvent = events.find((e) => e.param === 'title');
    expect(titleEvent?.type).toBe('literal');
  });
});

// ---------------------------------------------------------------------------
// computePreliminaryRubric
// ---------------------------------------------------------------------------

describe('computePreliminaryRubric', () => {
  const baseTask: EvalTask = {
    taskId: 't1',
    description: 'Do something',
    multiStep: false,
    lowSignal: true,
  };

  it('returns score 5, round 1 when no expectedTools defined', () => {
    const r = computePreliminaryRubric(baseTask, ['search']);
    expect(r.score).toBe(5);
    expect(r.round).toBe(1);
  });

  it('returns score 9 when all expected tools called', () => {
    const task = { ...baseTask, expectedTools: ['search', 'get'] };
    const r = computePreliminaryRubric(task, ['search', 'get']);
    expect(r.score).toBe(9);
  });

  it('returns score 2 when no expected tools called', () => {
    const task = { ...baseTask, expectedTools: ['search', 'get'] };
    const r = computePreliminaryRubric(task, ['process']);
    expect(r.score).toBe(2);
  });

  it('returns intermediate score for partial match', () => {
    const task = { ...baseTask, expectedTools: ['search', 'get', 'process'] };
    const r = computePreliminaryRubric(task, ['search']); // 1/3
    expect(r.score).toBeGreaterThanOrEqual(1);
    expect(r.score).toBeLessThan(9);
  });
});

// ---------------------------------------------------------------------------
// ClaudeHarness with mock client
// ---------------------------------------------------------------------------

describe('ClaudeHarness.runTask — mock client', () => {
  /**
   * Build a minimal mock Anthropic client.
   *
   * The scenario: agent is asked to retrieve note 'note-1' (literal).
   * Agent calls 'get' with id='note-1' (literal), then ends.
   */
  function buildMockClient(scenario: 'literal' | 'fabricated' | 'multi-step') {
    // Simulate two calls: first returns tool_use, second returns end_turn.
    const mockCreate = vi.fn();

    if (scenario === 'literal') {
      // Turn 1: call 'get' with id='note-1' (literal from task desc)
      // Turn 2: end_turn with text result
      mockCreate
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'get',
              input: { id: 'note-1' },
              caller: { type: 'direct' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 30 },
          content: [{ type: 'text', text: 'The note was found.', citations: null }],
        });
    } else if (scenario === 'fabricated') {
      // Turn 1: call 'get' with id='note-999' (fabricated — not in desc or prior returns)
      // Turn 2: end_turn
      mockCreate
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'get',
              input: { id: 'note-999' },
              caller: { type: 'direct' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 30 },
          content: [{ type: 'text', text: 'Result.', citations: null }],
        });
    } else {
      // multi-step: 'process' then 'get' with the returned id (traced)
      mockCreate
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'process',
              input: { data: 'Project Alpha', type: 'note' },
              caller: { type: 'direct' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          usage: { input_tokens: 90, output_tokens: 40 },
          content: [
            {
              type: 'tool_use',
              id: 'tu-2',
              name: 'get',
              // id comes from process return → traced
              input: { id: 'note-100' },
              caller: { type: 'direct' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 30 },
          content: [{ type: 'text', text: 'Done.', citations: null }],
        });
    }

    return {
      messages: { create: mockCreate },
    };
  }

  function buildSandbox(toolNames: string[], callReturnValue: unknown): Sandbox {
    const toolset: Toolset = {
      listTools: vi.fn().mockResolvedValue(toolNames.map(makeToolDef)),
      callTool: vi.fn().mockResolvedValue(callReturnValue),
    };
    return new Sandbox(toolset, new Set(toolNames));
  }

  it('returns a TaskTrace with correct taskId and chosenTools (literal scenario)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const harness = new ClaudeHarness({ client: buildMockClient('literal') as any });
    const task: EvalTask = {
      taskId: 'single-get-001',
      description: "Retrieve the note with ID 'note-1' and report its title.",
      multiStep: false,
      lowSignal: true,
      expectedTools: ['get'],
    };
    const toolset: Toolset = {
      listTools: vi.fn().mockResolvedValue([makeToolDef('get')]),
      callTool: vi.fn().mockResolvedValue({ id: 'note-1', title: 'Introduction' }),
    };
    const sandbox = new Sandbox(toolset, new Set(['get']));

    const trace = await harness.runTask(task, toolset, sandbox);

    expect(trace.taskId).toBe('single-get-001');
    expect(trace.chosenTools).toEqual(['get']);
    expect(trace.tokenCost).toBeGreaterThan(0);
    expect(trace.multiStep).toBe(false);
    expect(trace.lowSignal).toBe(true);
  });

  it('provenance:fabricated fires when agent fabricates an argument', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const harness = new ClaudeHarness({ client: buildMockClient('fabricated') as any });
    const task: EvalTask = {
      taskId: 'fabricated-test',
      description: 'Find the meeting note about Q1.',
      multiStep: false,
      lowSignal: false,
      expectedTools: ['get'],
    };
    const toolset: Toolset = {
      listTools: vi.fn().mockResolvedValue([makeToolDef('get')]),
      callTool: vi.fn().mockResolvedValue({ id: 'note-999', title: 'Something' }),
    };
    const sandbox = new Sandbox(toolset, new Set(['get']));

    const trace = await harness.runTask(task, toolset, sandbox);

    // 'note-999' is not in task description and not in any prior return
    const fabricated = trace.provenanceEvents.filter((e) => e.type === 'fabricated');
    expect(fabricated.length).toBeGreaterThan(0);
    expect(fabricated[0].tool).toBe('get');
    expect(fabricated[0].param).toBe('id');
  });

  it('provenance:traced fires for multi-step when id comes from prior return', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const harness = new ClaudeHarness({ client: buildMockClient('multi-step') as any });
    const task: EvalTask = {
      taskId: 'multi-create-verify-001',
      description:
        "Create a note titled 'Project Alpha' with content 'Initial planning'. Then retrieve it.",
      multiStep: true,
      lowSignal: false,
      expectedTools: ['process', 'get'],
    };
    // process returns note-100; get uses note-100 (traced)
    const toolset: Toolset = {
      listTools: vi
        .fn()
        .mockResolvedValue([makeToolDef('process'), makeToolDef('get')]),
      callTool: vi
        .fn()
        .mockResolvedValueOnce({ id: 'note-100', title: 'Project Alpha' }) // process return
        .mockResolvedValueOnce({ id: 'note-100', content: 'Initial planning' }), // get return
    };
    const sandbox = new Sandbox(toolset, new Set(['process', 'get']));

    const trace = await harness.runTask(task, toolset, sandbox);

    expect(trace.chosenTools).toEqual(['process', 'get']);
    // The 'id' argument to 'get' is 'note-100', which is in the process return
    const getEvents = trace.provenanceEvents.filter(
      (e) => e.tool === 'get' && e.param === 'id',
    );
    expect(getEvents).toHaveLength(1);
    expect(getEvents[0].type).toBe('traced');
  });

  it('TaskTrace validates against expected shape', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const harness = new ClaudeHarness({ client: buildMockClient('literal') as any });
    const task: EvalTask = {
      taskId: 'shape-test',
      description: "Retrieve the note with ID 'note-1'.",
      multiStep: false,
      lowSignal: true,
      expectedTools: ['get'],
    };
    const toolset: Toolset = {
      listTools: vi.fn().mockResolvedValue([makeToolDef('get')]),
      callTool: vi.fn().mockResolvedValue({ id: 'note-1' }),
    };
    const sandbox = new Sandbox(toolset, new Set(['get']));

    const trace = await harness.runTask(task, toolset, sandbox);

    // Verify all required TaskTrace fields are present
    expect(typeof trace.taskId).toBe('string');
    expect(typeof trace.multiStep).toBe('boolean');
    expect(typeof trace.lowSignal).toBe('boolean');
    expect(typeof trace.pass).toBe('boolean');
    expect(typeof trace.tokenCost).toBe('number');
    expect(Array.isArray(trace.chosenTools)).toBe(true);
    expect(Array.isArray(trace.provenanceEvents)).toBe(true);
    expect(typeof trace.rubric.score).toBe('number');
    expect(typeof trace.rubric.round).toBe('number');
    expect(trace.rubric.score).toBeGreaterThanOrEqual(1);
    expect(trace.rubric.score).toBeLessThanOrEqual(10);
  });
});
