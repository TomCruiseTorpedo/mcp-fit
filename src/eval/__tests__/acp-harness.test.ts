/**
 * AcpHarness tests (ADR-G) — driven against the deterministic fake ACP agent
 * fixture (fixtures/acp-agents/fake-agent.mjs), a zero-dependency independent
 * wire implementation. Covers the spec scenarios: observe-don't-intercept,
 * honest token cost, degraded-trace and no-contact detection, and headless
 * permissions.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { AcpHarness, AcpHarnessError, attributeToolCall, pickPermissionOption } from '../acp-harness.js';
import type { EvalTask } from '../harness.js';
import { createSandbox, type Toolset } from '../sandbox.js';
import type { ToolDef } from '../../types.js';

const FAKE_AGENT = fileURLToPath(
  new URL('../../../fixtures/acp-agents/fake-agent.mjs', import.meta.url),
);

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const TOOL_NAMES = ['weather_lookup', 'weather_forecast'];

function toolDef(name: string): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    findings: [],
  };
}

/** A toolset whose callTool must never fire (observe-don't-intercept). */
function makeToolset(): { toolset: Toolset; calls: () => number } {
  let count = 0;
  const toolset: Toolset = {
    listTools: async () => TOOL_NAMES.map(toolDef),
    callTool: async () => {
      count += 1;
      throw new Error('callTool must never be invoked by AcpHarness');
    },
  };
  return { toolset, calls: () => count };
}

const TASK: EvalTask = {
  taskId: 'acp-t1',
  description: 'Look up the weather in Calgary',
  multiStep: false,
  lowSignal: false,
  expectedTools: ['weather_lookup'],
};

function harness(mode: string, extra: Record<string, string> = {}, timeoutMs?: number): AcpHarness {
  return new AcpHarness({
    agent: {
      id: `fake-${mode}`,
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_ACP_MODE: mode, ...extra },
    },
    targetServer: {
      name: 'strawman-target',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1e6)'], // never actually spawned by the fake
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

async function run(mode: string, extra: Record<string, string> = {}, timeoutMs?: number) {
  const { toolset, calls } = makeToolset();
  const sandbox = createSandbox(toolset, new Set(TOOL_NAMES));
  const trace = await harness(mode, extra, timeoutMs).runTask(TASK, toolset, sandbox);
  return { trace, sandboxCalls: calls() };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('AcpHarness happy path (spec: observe-don\'t-intercept)', () => {
  it('reconstructs the transcript from tool_call updates without calling sandbox.callTool', async () => {
    const { trace, sandboxCalls } = await run('happy');

    expect(sandboxCalls).toBe(0);
    expect(trace.chosenTools).toEqual(['weather_lookup']);
    expect(trace.pass).toBe(true);
    expect(trace.degraded).toBeUndefined();
    expect(trace.taskId).toBe('acp-t1');
    expect(trace.rubric.score).toBeGreaterThanOrEqual(9);
  });

  it('reports tokenCost as null — not measured, never fabricated (spec: token cost is honest)', async () => {
    const { trace } = await run('happy');
    expect(trace.tokenCost).toBeNull();
  });

  it('computes provenance from rawInput: task-literal values classify as literal', async () => {
    const { trace } = await run('happy');
    const city = trace.provenanceEvents.find((e) => e.param === 'city');
    expect(city?.type).toBe('literal'); // 'Calgary' appears in the task description
  });

  it('passes the target MCP server through session/new mcpServers', async () => {
    const { trace } = await run('happy');
    const echoed = trace.provenanceEvents.find((e) => e.param === 'receivedServer');
    expect(echoed?.value).toBe('strawman-target');
  });

  it('attributes human-readable titles via the word-match rung', async () => {
    const { trace } = await run('happy', { FAKE_ACP_TITLE: 'Weather Lookup' });
    expect(trace.chosenTools).toEqual(['weather_lookup']);
  });
});

describe('AcpHarness degraded-trace detection (spec: degraded-trace detection)', () => {
  it('marks the trace degraded when rawInput is missing, without fabricating provenance', async () => {
    const { trace } = await run('no-raw');
    expect(trace.degraded).toBe(true);
    expect(trace.chosenTools).toEqual(['weather_lookup']); // still attributed
    expect(trace.provenanceEvents).toEqual([]); // nothing fabricated
  });

  it('marks the trace degraded when tool activity cannot be attributed to the target', async () => {
    const { trace } = await run('unattributed');
    expect(trace.degraded).toBe(true);
    expect(trace.chosenTools).toEqual([]);
  });
});

describe('AcpHarness no-contact detection (spec: no-contact detection)', () => {
  it('fails and degrades a run where the agent never issues a tool call', async () => {
    const { trace } = await run('no-contact');
    expect(trace.pass).toBe(false);
    expect(trace.degraded).toBe(true);
    expect(trace.chosenTools).toEqual([]);
  });
});

describe('AcpHarness headless permissions (spec: headless permissions)', () => {
  it('auto-grants via the allow_once option and the run proceeds', async () => {
    const { trace } = await run('permission');
    // The fake agent only runs its tool flow if the harness selected the
    // allow_once option (optionId 'allow-1') — a pass proves the grant.
    expect(trace.pass).toBe(true);
    expect(trace.chosenTools).toEqual(['weather_lookup']);
  });
});

describe('AcpHarness failure semantics (ADR-G7)', () => {
  it('throws AcpHarnessError when the agent exceeds the task budget', async () => {
    await expect(run('hang', {}, 1_500)).rejects.toThrow(AcpHarnessError);
    await expect(run('hang', {}, 1_500)).rejects.toThrow(/task budget/);
  });

  it('throws AcpHarnessError when the agent binary cannot be spawned', async () => {
    const { toolset } = makeToolset();
    const sandbox = createSandbox(toolset, new Set(TOOL_NAMES));
    const bad = new AcpHarness({
      agent: { id: 'missing', command: '/nonexistent/agent-binary', args: [] },
      targetServer: { name: 't', command: 'true', args: [] },
      timeoutMs: 2_000,
    });
    await expect(bad.runTask(TASK, toolset, sandbox)).rejects.toThrow(AcpHarnessError);
  });
});

// ---------------------------------------------------------------------------
// Unit: attribution ladder (ADR-G4)
// ---------------------------------------------------------------------------

describe('attributeToolCall', () => {
  const names = ['weather_lookup', 'weather_forecast', 'stock_quote'];

  it('rung 1: exact title match', () => {
    expect(attributeToolCall('weather_lookup', names)).toBe('weather_lookup');
  });

  it('rung 2: single whole-word match, case- and separator-insensitive', () => {
    expect(attributeToolCall('Running Weather Lookup', names)).toBe('weather_lookup');
    expect(attributeToolCall('stock-quote for AAPL', names)).toBe('stock_quote');
  });

  it('never guesses: ambiguous multi-matches stay unattributed', () => {
    expect(attributeToolCall('weather_lookup then weather_forecast', names)).toBeNull();
  });

  it('unmatched titles stay unattributed', () => {
    expect(attributeToolCall('Doing something mysterious', names)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: permission option choice (ADR-G5)
// ---------------------------------------------------------------------------

describe('pickPermissionOption', () => {
  it('prefers allow_once over allow_always', () => {
    const picked = pickPermissionOption([
      { optionId: 'a', name: 'Always', kind: 'allow_always' },
      { optionId: 'o', name: 'Once', kind: 'allow_once' },
    ]);
    expect(picked?.optionId).toBe('o');
  });

  it('falls back to allow_always when allow_once is absent', () => {
    const picked = pickPermissionOption([
      { optionId: 'r', name: 'Reject', kind: 'reject_once' },
      { optionId: 'a', name: 'Always', kind: 'allow_always' },
    ]);
    expect(picked?.optionId).toBe('a');
  });

  it('returns null when no allow option exists', () => {
    expect(
      pickPermissionOption([{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]),
    ).toBeNull();
  });
});
