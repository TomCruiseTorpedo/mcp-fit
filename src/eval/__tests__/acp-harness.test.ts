/**
 * AcpHarness tests (ADR-G) — driven against the deterministic fake ACP agent
 * fixture (fixtures/acp-agents/fake-agent.mjs), a zero-dependency independent
 * wire implementation. Covers the spec scenarios: observe-don't-intercept,
 * honest token cost, degraded-trace and no-contact detection, and headless
 * permissions.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AcpHarness,
  AcpHarnessError,
  attributeToolCall,
  buildAgentEnv,
  buildPrompt,
  copyAuthHomeFiles,
  gradeClaims,
  parseClaimsManifest,
  pickPermissionOption,
  targetFromPackage,
  type AcpEvalTask,
  type AcpHarnessOptions,
  type TargetServerSpec,
} from '../acp-harness.js';
import type { AcpAgentSpec } from '../acp-agents.js';
import type { EvalTask } from '../harness.js';
import { createSandbox, type Toolset } from '../sandbox.js';
import type { TaskTrace, ToolDef } from '../../types.js';
import { validateTaskTraceSchema } from '../../report/emit.js';

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

// ---------------------------------------------------------------------------
// ADR-G8 scaffolding: configurable runs
// ---------------------------------------------------------------------------

interface RunSpec {
  mode: string;
  env?: Record<string, string>;
  task?: AcpEvalTask;
  isolation?: AcpHarnessOptions['isolation'];
  targetServer?: TargetServerSpec;
  agent?: Partial<AcpAgentSpec>;
}

const DEFAULT_TARGET: TargetServerSpec = {
  name: 'strawman-target',
  command: process.execPath,
  args: ['-e', 'setInterval(()=>{},1e6)'], // never actually spawned by the fake
};

async function runWith(spec: RunSpec): Promise<TaskTrace> {
  const { toolset } = makeToolset();
  const sandbox = createSandbox(toolset, new Set(TOOL_NAMES));
  const h = new AcpHarness({
    agent: {
      id: `fake-${spec.mode}`,
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_ACP_MODE: spec.mode, ...spec.env },
      ...spec.agent,
    },
    targetServer: spec.targetServer ?? DEFAULT_TARGET,
    ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
  });
  return h.runTask(spec.task ?? TASK, toolset, sandbox);
}

function seen(trace: TaskTrace, param: string): unknown {
  return trace.provenanceEvents.find((e) => e.param === param)?.value;
}

// ---------------------------------------------------------------------------
// Axis 1: client isolation (ADR-G8)
// ---------------------------------------------------------------------------

describe('AcpHarness client isolation (spec: agent client isolation)', () => {
  const PLANTED = `planted-${process.pid}-${Date.now()}`;

  afterEach(() => {
    delete process.env['MCPFIT_PLANTED_SECRET'];
  });

  it('clean (default): the agent gets a disposable HOME and none of the operator-only variables', async () => {
    process.env['MCPFIT_PLANTED_SECRET'] = PLANTED;
    const trace = await runWith({ mode: 'report-env' });

    const home = seen(trace, 'seenHome');
    expect(typeof home).toBe('string');
    expect(home).not.toBe(homedir());
    expect(String(home).startsWith(tmpdir())).toBe(true);
    expect(seen(trace, 'seenXdgConfig')).toBe(join(String(home), '.config'));
    expect(seen(trace, 'seenPlanted')).toBeNull();
    expect(trace.isolation).toBe('clean');
  });

  it('clean: the disposable HOME is removed after the run', async () => {
    const trace = await runWith({ mode: 'report-env' });
    const home = String(seen(trace, 'seenHome'));
    expect(existsSync(home)).toBe(false);
  });

  it('control — inherit: the same agent DOES see the operator-only variable and the real HOME', async () => {
    process.env['MCPFIT_PLANTED_SECRET'] = PLANTED;
    const trace = await runWith({ mode: 'report-env', isolation: 'inherit' });
    expect(seen(trace, 'seenPlanted')).toBe(PLANTED);
    expect(seen(trace, 'seenHome')).toBe(process.env['HOME']);
    expect(trace.isolation).toBe('inherit');
  });

  it('fails before spawning when a required agent has no credentials', async () => {
    const run = runWith({
      mode: 'happy',
      // A command that cannot spawn: reaching spawn would raise a different error.
      agent: { command: '/nonexistent/agent-binary', auth: { env: ['MCPFIT_TEST_TOKEN_UNSET'], required: true } },
    });
    await expect(run).rejects.toThrow(AcpHarnessError);
    await expect(
      runWith({
        mode: 'happy',
        agent: { command: '/nonexistent/agent-binary', auth: { env: ['MCPFIT_TEST_TOKEN_UNSET'], required: true } },
      }),
    ).rejects.toThrow(/no credentials under clean isolation/);
  });

  it('runs a required agent once one declared credential is present, and passes it through', async () => {
    process.env['MCPFIT_PLANTED_SECRET'] = PLANTED;
    const trace = await runWith({
      mode: 'report-env',
      agent: { auth: { env: ['MCPFIT_PLANTED_SECRET'], required: true } },
    });
    // Declared as auth, so it IS passed — the allowlist is the declaration.
    expect(seen(trace, 'seenPlanted')).toBe(PLANTED);
  });
});

describe('buildAgentEnv', () => {
  const agent: AcpAgentSpec = {
    id: 'a',
    command: 'x',
    args: [],
    env: { EXTRA: '1' },
    auth: { env: ['TOKEN_A'] },
  };
  const parent = { PATH: '/bin', HOME: '/Users/op', SECRET: 's', TOKEN_A: 't', LANG: 'en_CA.UTF-8' };

  it('clean keeps the allowlist, replaces HOME, passes declared auth and agent.env, drops the rest', () => {
    const env = buildAgentEnv('clean', agent, '/tmp/h', parent, '/Users/op');
    expect(env['PATH']).toBe('/bin');
    expect(env['LANG']).toBe('en_CA.UTF-8');
    expect(env['HOME']).toBe('/tmp/h');
    expect(env['XDG_CACHE_HOME']).toBe('/tmp/h/.cache');
    expect(env['TOKEN_A']).toBe('t');
    expect(env['EXTRA']).toBe('1');
    expect(env['npm_config_cache']).toBe('/Users/op/.npm');
    expect(env['SECRET']).toBeUndefined();
  });

  it('inherit passes the whole environment (pre-1.2.0 behaviour)', () => {
    const env = buildAgentEnv('inherit', agent, undefined, parent, '/Users/op');
    expect(env['SECRET']).toBe('s');
    expect(env['HOME']).toBe('/Users/op');
    expect(env['EXTRA']).toBe('1');
  });
});

describe('copyAuthHomeFiles', () => {
  it('copies declared files into the clean home with mode 0600 and skips missing ones', async () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'mcp-fit-test-op-'));
    const home = mkdtempSync(join(tmpdir(), 'mcp-fit-test-home-'));
    try {
      mkdirSync(join(operatorHome, '.agent'));
      writeFileSync(join(operatorHome, '.agent', 'token.json'), '{"t":1}');
      const agent: AcpAgentSpec = {
        id: 'a',
        command: 'x',
        args: [],
        auth: { homeFiles: ['.agent/token.json', '.agent/missing.json'] },
      };
      const copied = await copyAuthHomeFiles(agent, home, operatorHome);
      expect(copied).toEqual([join('.agent', 'token.json')]);
      expect(statSync(join(home, '.agent', 'token.json')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses entries that escape HOME', async () => {
    const agent = (rel: string): AcpAgentSpec => ({ id: 'a', command: 'x', args: [], auth: { homeFiles: [rel] } });
    await expect(copyAuthHomeFiles(agent('../outside'), '/tmp/h', '/Users/op')).rejects.toThrow(AcpHarnessError);
    await expect(copyAuthHomeFiles(agent('/etc/passwd'), '/tmp/h', '/Users/op')).rejects.toThrow(AcpHarnessError);
  });
});

// ---------------------------------------------------------------------------
// Axis 2: published-package targets (ADR-G8)
// ---------------------------------------------------------------------------

describe('targetFromPackage', () => {
  it('launches the exact published version the way users do and records its source', () => {
    const t = targetFromPackage('@scope/weather-mcp', '1.4.2', { args: ['--stdio'] });
    expect(t.command).toBe('npx');
    expect(t.args).toEqual(['--yes', '@scope/weather-mcp@1.4.2', '--stdio']);
    expect(t.source).toEqual({ kind: 'package', package: '@scope/weather-mcp', version: '1.4.2' });
  });

  it('refuses ranges, dist-tags, build metadata and invalid names', () => {
    expect(() => targetFromPackage('weather-mcp', 'latest')).toThrow(RangeError);
    expect(() => targetFromPackage('weather-mcp', '^1.4.2')).toThrow(RangeError);
    expect(() => targetFromPackage('weather-mcp', '1.4.2+build.7')).toThrow(RangeError);
    expect(() => targetFromPackage('Weather MCP', '1.4.2')).toThrow(RangeError);
    expect(() => targetFromPackage('weather-mcp', '1.4.2-rc.1')).not.toThrow();
  });

  it('records the subject on the trace: package for targetFromPackage, command otherwise', async () => {
    const pkgTarget = { ...targetFromPackage('weather-mcp', '1.4.2'), name: 'weather' };
    const viaPackage = await runWith({ mode: 'happy', targetServer: pkgTarget });
    expect(viaPackage.subject).toEqual({ name: 'weather', source: 'package', package: 'weather-mcp', version: '1.4.2' });

    const viaCommand = await runWith({ mode: 'happy' });
    expect(viaCommand.subject).toEqual({ name: 'strawman-target', source: 'command' });
  });
});

// ---------------------------------------------------------------------------
// Axis 4: zero-call negative scenario (ADR-G8)
// ---------------------------------------------------------------------------

const NEGATIVE: AcpEvalTask = {
  taskId: 'acp-neg',
  description: 'Fix the app.',
  multiStep: false,
  lowSignal: false,
  expectNoToolCalls: true,
};

describe('AcpHarness negative scenario (spec: zero-call negative scenario)', () => {
  it('passes, undegraded, when the agent correctly makes no tool calls', async () => {
    const trace = await runWith({ mode: 'no-contact', task: NEGATIVE });
    expect(trace.pass).toBe(true);
    expect(trace.degraded).toBeUndefined();
  });

  it('control — fails when the agent calls a tool anyway', async () => {
    const trace = await runWith({ mode: 'happy', task: NEGATIVE });
    expect(trace.pass).toBe(false);
  });

  it('requires positive evidence when expectReplyMatches is set: a clarifying question passes', async () => {
    const task: AcpEvalTask = { ...NEGATIVE, expectReplyMatches: '\\?\\s*$' };
    const trace = await runWith({
      mode: 'no-contact',
      task,
      env: { FAKE_ACP_REPLY: 'Which app do you mean, and where is it?' },
    });
    expect(trace.pass).toBe(true);
  });

  it('control — silence alone fails when expectReplyMatches is set', async () => {
    const task: AcpEvalTask = { ...NEGATIVE, expectReplyMatches: '\\?\\s*$' };
    const trace = await runWith({ mode: 'no-contact', task });
    expect(trace.pass).toBe(false);
  });

  it('rejects a malformed reply pattern before running anything', async () => {
    const task: AcpEvalTask = { ...NEGATIVE, expectReplyMatches: '(' };
    await expect(runWith({ mode: 'no-contact', task })).rejects.toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// Axis 3: closed-set claims manifest (ADR-G8)
// ---------------------------------------------------------------------------

const CLAIMS_TASK: AcpEvalTask = {
  ...TASK,
  taskId: 'acp-claims',
  claims: [
    { id: 'temp', question: 'What temperature in Celsius did the tool report?', expected: 22 },
    { id: 'conditions', question: 'What conditions did the tool report?', expected: 'sunny' },
  ],
};
const OUTPUT_WITH_BOTH = JSON.stringify({ tempC: 22, conditions: 'sunny' });

function manifest(entries: Array<{ id: string; value: unknown }>): string {
  return JSON.stringify({ claims: entries });
}

describe('AcpHarness claims manifest (spec: closed-set claims manifest)', () => {
  it('passes when every claim is reported once, matches the oracle, and came from a tool output', async () => {
    const trace = await runWith({
      mode: 'claims',
      task: CLAIMS_TASK,
      env: {
        FAKE_ACP_OUTPUT: OUTPUT_WITH_BOTH,
        FAKE_ACP_MANIFEST: manifest([
          { id: 'temp', value: 22 },
          { id: 'conditions', value: 'sunny' },
        ]),
      },
    });
    expect(trace.claims).toEqual({
      total: 2,
      passed: 2,
      results: [
        { id: 'temp', ok: true },
        { id: 'conditions', ok: true },
      ],
      extra: [],
    });
    expect(trace.pass).toBe(true);
  });

  it('control — a wrong value fails the claim and the task', async () => {
    const trace = await runWith({
      mode: 'claims',
      task: CLAIMS_TASK,
      env: {
        FAKE_ACP_OUTPUT: OUTPUT_WITH_BOTH,
        FAKE_ACP_MANIFEST: manifest([
          { id: 'temp', value: 23 },
          { id: 'conditions', value: 'sunny' },
        ]),
      },
    });
    expect(trace.claims?.results[0]).toEqual({ id: 'temp', ok: false, reason: 'wrong-value' });
    expect(trace.pass).toBe(false);
  });

  it('control — a correct value that no tool returned is unsourced', async () => {
    const trace = await runWith({
      mode: 'claims',
      task: CLAIMS_TASK,
      env: {
        FAKE_ACP_OUTPUT: JSON.stringify({ tempC: 22 }), // no "sunny" anywhere in tool output
        FAKE_ACP_MANIFEST: manifest([
          { id: 'temp', value: 22 },
          { id: 'conditions', value: 'sunny' },
        ]),
      },
    });
    expect(trace.claims?.results[1]).toEqual({ id: 'conditions', ok: false, reason: 'unsourced' });
    expect(trace.pass).toBe(false);
  });

  it('output from an UNATTRIBUTED call is not a source', async () => {
    const trace = await runWith({
      mode: 'claims',
      task: CLAIMS_TASK,
      env: {
        FAKE_ACP_TITLE: 'Doing something mysterious',
        FAKE_ACP_OUTPUT: OUTPUT_WITH_BOTH,
        FAKE_ACP_MANIFEST: manifest([
          { id: 'temp', value: 22 },
          { id: 'conditions', value: 'sunny' },
        ]),
      },
    });
    expect(trace.claims?.passed).toBe(0);
    expect(trace.claims?.results.every((r) => r.reason === 'unsourced')).toBe(true);
  });

  it('missing, duplicate and extra ids each fail', async () => {
    const trace = await runWith({
      mode: 'claims',
      task: CLAIMS_TASK,
      env: {
        FAKE_ACP_OUTPUT: OUTPUT_WITH_BOTH,
        FAKE_ACP_MANIFEST: manifest([
          { id: 'conditions', value: 'sunny' },
          { id: 'conditions', value: 'sunny' },
          { id: 'humidity', value: 40 },
        ]),
      },
    });
    expect(trace.claims?.results).toEqual([
      { id: 'temp', ok: false, reason: 'missing' },
      { id: 'conditions', ok: false, reason: 'duplicate' },
    ]);
    expect(trace.claims?.extra).toEqual(['humidity']);
    expect(trace.pass).toBe(false);
  });

  it('a reply without a manifest fails every claim as no-manifest', async () => {
    const trace = await runWith({ mode: 'happy', task: CLAIMS_TASK, env: { FAKE_ACP_OUTPUT: OUTPUT_WITH_BOTH } });
    expect(trace.claims?.results.map((r) => r.reason)).toEqual(['no-manifest', 'no-manifest']);
    expect(trace.pass).toBe(false);
  });

  it('the prompt carries claim ids and questions but never the expected values', () => {
    const prompt = buildPrompt({
      ...CLAIMS_TASK,
      claims: [{ id: 'code', question: 'What status code came back?', expected: 'XQ-4471-ORACLE' }],
    });
    expect(prompt).toContain('code: What status code came back?');
    expect(prompt).not.toContain('XQ-4471-ORACLE');
  });

  it('parseClaimsManifest takes the last claims block and ignores other code blocks', () => {
    const reply =
      '```json\n{"claims":[{"id":"a","value":1}]}\n```\n' +
      '```js\nconsole.log(1)\n```\n' +
      '```json\n{"claims":[{"id":"a","value":2}]}\n```';
    expect(parseClaimsManifest(reply)).toEqual([{ id: 'a', value: 2 }]);
    expect(parseClaimsManifest('no blocks here')).toBeNull();
  });

  it('gradeClaims compares numbers numerically and strings after trimming', () => {
    const grade = gradeClaims(
      [
        { id: 'n', question: 'q', expected: 22 },
        { id: 's', question: 'q', expected: 'sunny' },
      ],
      [
        { id: 'n', value: '22' },
        { id: 's', value: ' sunny ' },
      ],
      [{ tempC: 22, conditions: 'sunny' }],
    );
    expect(grade.passed).toBe(1); // ' sunny ' matches the oracle but is not found verbatim in the output
    expect(grade.results[1]?.reason).toBe('unsourced');
  });
});

// ---------------------------------------------------------------------------
// Contract: the new trace fields validate against evals.schema.json 1.2.0
// ---------------------------------------------------------------------------

describe('ADR-G8 traces against evals.schema.json', () => {
  it('a claims trace with isolation and subject validates', async () => {
    const trace = await runWith({
      mode: 'claims',
      task: CLAIMS_TASK,
      targetServer: targetFromPackage('weather-mcp', '1.4.2'),
      env: {
        FAKE_ACP_OUTPUT: OUTPUT_WITH_BOTH,
        FAKE_ACP_MANIFEST: manifest([{ id: 'temp', value: 22 }]),
      },
    });
    const result = validateTaskTraceSchema(trace);
    expect(result.valid).toBe(true);
  });

  it('control — the schema rejects an unknown claim failure reason', () => {
    const bad = {
      taskId: 't',
      multiStep: false,
      lowSignal: false,
      pass: false,
      tokenCost: null,
      chosenTools: [],
      provenanceEvents: [],
      rubric: { score: 2, round: 1 },
      claims: { total: 1, passed: 0, results: [{ id: 'x', ok: false, reason: 'bogus' }], extra: [] },
    };
    expect(validateTaskTraceSchema(bad).valid).toBe(false);
  });
});
