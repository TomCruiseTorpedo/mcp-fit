/**
 * ACP eval harness — drives any ACP-registry coding agent as the eval driver
 * (ADR-G; the v1.1 seam reserved by ADR-B).
 *
 * Trust topology inverts vs ClaudeHarness (ADR-G2): the agent executes tools
 * ITSELF against the target MCP server we hand it in `session/new mcpServers`;
 * this harness OBSERVES `tool_call` / `tool_call_update` session updates and
 * reconstructs the transcript by folding on `toolCallId`. `sandbox.callTool()`
 * is never invoked — `sandbox.listTools()` only supplies the target-tool
 * universe for attribution and no-contact detection.
 *
 * No ACP types leak outside this file and acp-agents.ts — the same
 * containment rule ClaudeHarness follows for Anthropic types.
 *
 * Spec: ACP Eval Harness (specs/mcp-fit/spec.md)
 * ADR: ADR-G (docs/adr/ADR-G-acp-harness.md)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionUpdate,
  type ToolCallStatus,
  type ToolKind,
} from '@agentclientprotocol/sdk';

import type {
  AgentIsolation,
  ClaimResult,
  ClaimsGrade,
  EvalSubject,
  ProvenanceEvent,
  TaskTrace,
} from '../types.js';
import { createDisposableWorkspace, type DisposableWorkspace } from '../connect/transports.js';
import type { EvalTask, Harness } from './harness.js';
import { analyzeToolCallProvenance, classifyProvenance, computePreliminaryRubric } from './harness.js';
import type { Sandbox, Toolset } from './sandbox.js';
import type { AcpAgentSpec } from './acp-agents.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Stdio spawn spec for the TARGET MCP server handed to the agent (ADR-G2). */
export interface TargetServerSpec {
  /** Human-readable server name shown to the agent. */
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Set by `targetFromPackage` when the server is a published package
   * (ADR-G8). Recorded on the trace as `subject`; absent means an
   * operator-supplied command line.
   */
  source?: { kind: 'package'; package: string; version: string };
}

/** Options for constructing an AcpHarness. */
export interface AcpHarnessOptions {
  /** Which ACP agent to drive (see acp-agents.ts ACP_AGENTS). */
  agent: AcpAgentSpec;
  /** The MCP server under evaluation, passed to the agent via session/new. */
  targetServer: TargetServerSpec;
  /** Wall-clock budget per task before the run is aborted. Default 120 000 ms. */
  timeoutMs?: number;
  /**
   * How the agent's environment is prepared (ADR-G8). Default `clean`: a
   * disposable HOME and an allowlisted environment carrying only the agent's
   * declared auth. `inherit` hands the agent the operator's full environment
   * and HOME, so its results describe that operator's setup.
   */
  isolation?: AgentIsolation;
}

/** A claim the agent must report in its closing manifest (ADR-G8). */
export interface AcpClaimSpec {
  /** Stable claim id the agent echoes back. */
  id: string;
  /** The question put to the agent. Never contains the expected value. */
  question: string;
  /** The oracle value. Sent nowhere; used only for grading. */
  expected: string | number | boolean;
}

/**
 * An EvalTask with ACP-only fields (ADR-G8). These live here rather than on
 * EvalTask because `src/eval/harness.ts` is vendored byte-identically into
 * gatewarden (`scripts/score-engine.sha256`).
 */
export interface AcpEvalTask extends EvalTask {
  /**
   * Negative scenario: the correct behaviour is to make NO tool calls. Zero
   * calls then passes and is not degraded; any call fails the task.
   */
  expectNoToolCalls?: boolean;
  /**
   * A regular expression (source text) the agent's reply must match, such as
   * a clarifying question. Pair it with `expectNoToolCalls` so a negative
   * scenario needs positive evidence, not only silence: an agent that never
   * saw the server also makes zero calls.
   */
  expectReplyMatches?: string;
  /**
   * Closed-set claims. The prompt lists the ids and questions only; each
   * claim must come back exactly once, match `expected`, and appear in the
   * output of an attributed target-tool call.
   */
  claims?: AcpClaimSpec[];
}

/** Thrown on spawn/protocol failures and timeouts (ADR-G7). */
export class AcpHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpHarnessError';
  }
}

// ---------------------------------------------------------------------------
// Published-package targets (ADR-G8)
// ---------------------------------------------------------------------------

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// Exact versions only. Build metadata is refused because npm cannot install an
// exact version that carries it.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Target a published MCP server the way its users launch it:
 * `npx --yes <package>@<version>`. Ranges, dist-tags such as `latest` and
 * build metadata are refused, so a trace always names the exact artefact
 * that was evaluated.
 */
export function targetFromPackage(
  pkg: string,
  version: string,
  options: { name?: string; args?: string[]; env?: Record<string, string> } = {},
): TargetServerSpec {
  if (!NPM_PACKAGE_NAME.test(pkg)) {
    throw new RangeError(`targetFromPackage: '${pkg}' is not a valid npm package name`);
  }
  if (!EXACT_VERSION.test(version)) {
    throw new RangeError(
      `targetFromPackage: '${version}' is not an exact version (no ranges, dist-tags or build metadata)`,
    );
  }
  return {
    name: options.name ?? pkg,
    command: 'npx',
    args: ['--yes', `${pkg}@${version}`, ...(options.args ?? [])],
    ...(options.env !== undefined ? { env: options.env } : {}),
    source: { kind: 'package', package: pkg, version },
  };
}

// ---------------------------------------------------------------------------
// Agent environment (ADR-G8)
// ---------------------------------------------------------------------------

/**
 * Variables a `clean` run keeps from the operator's environment. The first six
 * match the MCP SDK's own stdio allowlist; HOME is replaced, not kept. LANG,
 * LC_ALL and TMPDIR are added because CLI agents misbehave without a locale
 * and macOS keeps per-user temp space in TMPDIR.
 */
const CLEAN_ENV_ALLOWLIST = ['PATH', 'LOGNAME', 'SHELL', 'TERM', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

/**
 * Build the agent's environment.
 *
 * `clean`: the allowlist above, HOME and the XDG directories pointed into the
 * disposable home, the agent's declared auth variables, then `agent.env`.
 * `npm_config_cache` keeps pointing at the operator's npm cache so `npx`
 * agents do not re-download per run; that directory holds package tarballs,
 * not configuration. Registry tokens live in `~/.npmrc`, which stays out.
 *
 * `inherit`: the operator's whole environment, then `agent.env` (pre-1.2.0).
 */
export function buildAgentEnv(
  isolation: AgentIsolation,
  agent: AcpAgentSpec,
  home: string | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
  operatorHome: string = homedir(),
): Record<string, string> {
  const env: Record<string, string> = {};

  if (isolation === 'inherit') {
    for (const [key, value] of Object.entries(parentEnv)) {
      if (value !== undefined) env[key] = value;
    }
    return { ...env, ...agent.env };
  }

  if (home === undefined) {
    throw new AcpHarnessError('clean isolation needs a disposable home');
  }
  for (const key of CLEAN_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env['HOME'] = home;
  env['XDG_CONFIG_HOME'] = join(home, '.config');
  env['XDG_DATA_HOME'] = join(home, '.local', 'share');
  env['XDG_STATE_HOME'] = join(home, '.local', 'state');
  env['XDG_CACHE_HOME'] = join(home, '.cache');
  env['npm_config_cache'] = parentEnv['npm_config_cache'] ?? join(operatorHome, '.npm');
  for (const key of agent.auth?.env ?? []) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...agent.env };
}

/**
 * Copy the agent's declared `auth.homeFiles` from the operator's HOME into
 * the disposable home, mode 0600. Missing files are skipped. Returns the
 * relative paths that were copied.
 */
export async function copyAuthHomeFiles(
  agent: AcpAgentSpec,
  home: string,
  operatorHome: string = homedir(),
): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of agent.auth?.homeFiles ?? []) {
    const clean = normalize(rel);
    if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`)) {
      throw new AcpHarnessError(
        `agent '${agent.id}': auth.homeFiles entry '${rel}' must be relative to HOME and stay inside it`,
      );
    }
    const from = join(operatorHome, clean);
    const isFile = await stat(from).then((s) => s.isFile(), () => false);
    if (!isFile) continue;
    const to = join(home, clean);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    await chmod(to, 0o600);
    copied.push(clean);
  }
  return copied;
}

/** Fail before spawning when a `required` agent would run without credentials. */
function assertAuthAvailable(
  agent: AcpAgentSpec,
  parentEnv: NodeJS.ProcessEnv,
  copiedFiles: readonly string[],
): void {
  const auth = agent.auth;
  if (auth?.required !== true) return;
  const envPresent = (auth.env ?? []).some((key) => parentEnv[key] !== undefined && parentEnv[key] !== '');
  if (envPresent || copiedFiles.length > 0) return;

  const wanted = [
    ...(auth.env ?? []).map((key) => `$${key}`),
    ...(auth.homeFiles ?? []).map((rel) => `~/${rel}`),
  ];
  throw new AcpHarnessError(
    `agent '${agent.id}' has no credentials under clean isolation: set one of ${wanted.join(', ')}. ` +
      `Running it logged out would show up as a no-contact trace instead of an auth failure.`,
  );
}

// ---------------------------------------------------------------------------
// Prompt and claims manifest (ADR-G8)
// ---------------------------------------------------------------------------

/**
 * The prompt sent to the agent. A claims task gets a closing instruction that
 * lists claim ids and questions only. Expected values never appear in the
 * prompt.
 */
export function buildPrompt(task: AcpEvalTask): string {
  const claims = task.claims ?? [];
  if (claims.length === 0) return task.description;
  const lines = claims.map((c) => `- ${c.id}: ${c.question}`);
  return (
    `${task.description}\n\n` +
    'When you have finished, end your reply with one fenced JSON block of exactly this shape:\n' +
    '```json\n{"claims": [{"id": "<claim id>", "value": <your answer>}]}\n```\n' +
    'Report each of these claims exactly once, using values you obtained from the tools:\n' +
    lines.join('\n')
  );
}

/** One `{id, value}` entry read from the agent's manifest. */
interface ManifestEntry {
  id: string;
  value: unknown;
}

/**
 * Read the claims manifest from the agent's reply: the LAST fenced code block
 * that parses as `{"claims": [...]}`. Entries without a string `id` are
 * dropped. Returns null when no such block exists.
 */
export function parseClaimsManifest(reply: string): ManifestEntry[] | null {
  // Fences are anchored to line starts: an unanchored pattern pairs one
  // block's closing fence with the next block's opening fence, so a non-JSON
  // block in between changes which manifest reads as "last".
  const blocks = [...reply.matchAll(/^```[^\n`]*\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? '');
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[i] ?? '');
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const claims = (parsed as { claims?: unknown }).claims;
    if (!Array.isArray(claims)) continue;
    return claims
      .filter(
        (c): c is { id: string; value?: unknown } =>
          c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string',
      )
      .map((c) => ({ id: c.id, value: c.value }));
  }
  return null;
}

/** Oracle comparison: strings trim-equal, numbers numeric-equal, booleans strict. */
function claimValueMatches(expected: string | number | boolean, value: unknown): boolean {
  if (typeof expected === 'string') {
    return typeof value === 'string' && value.trim() === expected.trim();
  }
  if (typeof expected === 'number') {
    if (typeof value === 'number') return value === expected;
    return typeof value === 'string' && value.trim() !== '' && Number(value) === expected;
  }
  return value === expected;
}

/**
 * Grade a closed set of claims (ADR-G8). Each requested claim must appear in
 * the manifest exactly once, equal its oracle value, and be traced to an
 * attributed target-tool output (the repo's provenance heuristic, with the
 * task description deliberately excluded so a value cannot pass by being in
 * the prompt). Manifest ids that were not requested are returned in `extra`.
 */
export function gradeClaims(
  specs: readonly AcpClaimSpec[],
  manifest: readonly ManifestEntry[] | null,
  targetToolOutputs: readonly unknown[],
): ClaimsGrade {
  const results: ClaimResult[] = specs.map((spec) => {
    if (manifest === null) return { id: spec.id, ok: false, reason: 'no-manifest' };
    const entries = manifest.filter((e) => e.id === spec.id);
    if (entries.length === 0) return { id: spec.id, ok: false, reason: 'missing' };
    if (entries.length > 1) return { id: spec.id, ok: false, reason: 'duplicate' };
    const value = entries[0]?.value;
    if (!claimValueMatches(spec.expected, value)) return { id: spec.id, ok: false, reason: 'wrong-value' };
    if (classifyProvenance(value, '', [...targetToolOutputs]) !== 'traced') {
      return { id: spec.id, ok: false, reason: 'unsourced' };
    }
    return { id: spec.id, ok: true };
  });

  const requested = new Set(specs.map((s) => s.id));
  const extra = manifest === null ? [] : [...new Set(manifest.map((e) => e.id).filter((id) => !requested.has(id)))];

  return {
    total: specs.length,
    passed: results.filter((r) => r.ok).length,
    results,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Internal: transcript folding
// ---------------------------------------------------------------------------

/** One tool call folded from tool_call / tool_call_update notifications. */
interface FoldedToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Order of first appearance — preserves call order in chosenTools. */
  seq: number;
}

/** What one session produced: the folded tool calls and the agent's reply text. */
interface ObservedSession {
  calls: FoldedToolCall[];
  reply: string;
}

/** Fields a tool_call / tool_call_update notification may carry for folding. */
interface FoldableFields {
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Merge an update into the folded record: only present fields overwrite. */
function foldUpdate(target: FoldedToolCall, update: FoldableFields): void {
  if (update.title != null) target.title = update.title;
  if (update.kind != null) target.kind = update.kind;
  if (update.status != null) target.status = update.status;
  if (update.rawInput !== undefined) target.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) target.rawOutput = update.rawOutput;
}

// ---------------------------------------------------------------------------
// Internal: tool attribution ladder (ADR-G4)
// ---------------------------------------------------------------------------

/** Normalise for word matching: lowercase, _ and - become spaces. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[_\-]+/g, ' ');
}

/**
 * Attribute a folded tool call to a target tool name, or null.
 *
 * Ladder: (1) exact title match; (2) exactly ONE target name appears as a
 * whole word sequence in the title (ambiguous multi-matches stay
 * unattributed — never guess).
 */
export function attributeToolCall(
  title: string,
  targetToolNames: readonly string[],
): string | null {
  const exact = targetToolNames.find((n) => n === title);
  if (exact !== undefined) return exact;

  const normalisedTitle = ` ${normalise(title)} `;
  const wordMatches = targetToolNames.filter((n) =>
    normalisedTitle.includes(` ${normalise(n)} `),
  );
  return wordMatches.length === 1 ? (wordMatches[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Internal: pass inference
// ---------------------------------------------------------------------------

/**
 * Pass/fail from chosen tools vs expected — mirrors the private inferPass in
 * harness.ts (that file is sync-manifest-locked and cannot export it without
 * a mirrored gatewarden change; keep the two in agreement).
 */
function inferPass(task: EvalTask, chosenTools: string[]): boolean {
  if (!task.expectedTools || task.expectedTools.length === 0) {
    return chosenTools.length > 0;
  }
  const chosen = new Set(chosenTools);
  return task.expectedTools.every((t) => chosen.has(t));
}

// ---------------------------------------------------------------------------
// Internal: permission auto-grant (ADR-G5)
// ---------------------------------------------------------------------------

/** Pick the least-privilege allow option: allow_once, else any allow, else none. */
export function pickPermissionOption(
  options: readonly PermissionOption[],
): PermissionOption | null {
  return (
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind === 'allow_always') ??
    null
  );
}

// ---------------------------------------------------------------------------
// AcpHarness
// ---------------------------------------------------------------------------

export class AcpHarness implements Harness {
  private readonly agent: AcpAgentSpec;
  private readonly targetServer: TargetServerSpec;
  private readonly timeoutMs: number;
  private readonly isolation: AgentIsolation;

  constructor(options: AcpHarnessOptions) {
    this.agent = options.agent;
    this.targetServer = options.targetServer;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.isolation = options.isolation ?? 'clean';
  }

  /**
   * Run one eval task by driving the ACP agent subprocess.
   *
   * 1. Prepare the agent's environment: under `clean` isolation a disposable
   *    HOME holding only the declared auth (ADR-G8).
   * 2. Spawn the agent; wire an ndjson JSON-RPC stream over its stdio.
   * 3. initialize → session/new (scratch cwd + the target MCP server).
   * 4. Prompt with the task (plus the claims instruction, if any); fold
   *    tool_call updates and collect the reply text until stop.
   * 5. Attribute calls to target tools; compute provenance over rawInput;
   *    grade negative and claims tasks; emit a TaskTrace with tokenCost: null
   *    (ADR-G3) and degraded flags.
   */
  async runTask(task: EvalTask, toolset: Toolset, sandbox: Sandbox): Promise<TaskTrace> {
    void toolset; // sandbox wraps toolset; used only for the tool-name universe
    const acpTask = task as AcpEvalTask;

    // Reject a malformed reply pattern before paying for a run.
    const replyPattern =
      acpTask.expectReplyMatches !== undefined ? new RegExp(acpTask.expectReplyMatches) : undefined;

    const targetToolNames = (await sandbox.listTools()).map((t) => t.name);
    const scratchCwd = await mkdtemp(join(tmpdir(), 'mcp-fit-acp-'));
    let workspace: DisposableWorkspace | undefined;
    let child: ChildProcess | undefined;

    try {
      let env: Record<string, string>;
      if (this.isolation === 'clean') {
        workspace = createDisposableWorkspace();
        const copied = await copyAuthHomeFiles(this.agent, workspace.home);
        assertAuthAvailable(this.agent, process.env, copied);
        env = buildAgentEnv('clean', this.agent, workspace.home);
      } else {
        env = buildAgentEnv('inherit', this.agent, undefined);
      }

      child = spawn(this.agent.command, this.agent.args, {
        env,
        stdio: ['pipe', 'pipe', 'inherit'], // agent stderr passes through (ADR-G7)
      });

      const observed = await this.driveSession(child, acpTask, scratchCwd);
      return this.buildTrace(acpTask, observed, targetToolNames, replyPattern);
    } finally {
      await this.cleanup(child, scratchCwd);
      workspace?.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Session driving
  // -------------------------------------------------------------------------

  private async driveSession(
    child: ChildProcess,
    task: AcpEvalTask,
    scratchCwd: string,
  ): Promise<ObservedSession> {
    if (child.stdin === null || child.stdout === null) {
      throw new AcpHarnessError(`agent '${this.agent.id}' spawned without stdio pipes`);
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: 'mcp-fit' }).onRequest(
      'session/request_permission',
      ({ params }): RequestPermissionResponse => {
        const choice = pickPermissionOption(params.options);
        if (choice === null) {
          process.stderr.write(
            `mcp-fit: acp[${this.agent.id}]: permission request had no allow option — cancelling\n`,
          );
          return { outcome: { outcome: 'cancelled' } };
        }
        process.stderr.write(
          `mcp-fit: acp[${this.agent.id}]: auto-granting permission '${choice.name}' (${choice.kind})\n`,
        );
        return { outcome: { outcome: 'selected', optionId: choice.optionId } };
      },
    );

    // Spawn-failure surface: reject fast instead of hanging until timeout.
    const spawnFailure = new Promise<never>((_, reject) => {
      child.once('error', (err) =>
        reject(new AcpHarnessError(`agent '${this.agent.id}' failed to spawn: ${err.message}`)),
      );
    });

    const run = app.connectWith(stream, async (ctx) => {
      await ctx.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // No fs/terminal capabilities declared (ADR-G2) — the agent gets the
        // target MCP server and a scratch cwd, nothing else from us.
        clientCapabilities: {},
        clientInfo: { name: 'mcp-fit', version: 'acp-harness' },
      });

      const builder = ctx.buildSession({
        cwd: scratchCwd,
        mcpServers: [
          {
            name: this.targetServer.name,
            command: this.targetServer.command,
            args: this.targetServer.args,
            env: Object.entries(this.targetServer.env ?? {}).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      });

      return builder.withSession(async (session) => {
        const calls = new Map<string, FoldedToolCall>();
        let seq = 0;
        let reply = '';

        const promptDone = session.prompt(buildPrompt(task));
        // Surface prompt-side rejections through the update loop's await chain.
        promptDone.catch(() => undefined);

        for (;;) {
          const msg = await session.nextUpdate();
          if (msg.kind === 'stop') break;

          const update: SessionUpdate = msg.update;
          if (
            update.sessionUpdate === 'tool_call' ||
            update.sessionUpdate === 'tool_call_update'
          ) {
            const id = update.toolCallId;
            const existing = calls.get(id) ?? {
              toolCallId: id,
              title: '',
              seq: seq++,
            };
            foldUpdate(existing, update);
            calls.set(id, existing);
          } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            // The reply text carries the claims manifest and the evidence for
            // expectReplyMatches (ADR-G8).
            reply += update.content.text;
          }
          // Other update kinds (thought chunks, plans, usage_update) are
          // irrelevant to the trace: usage_update reports context occupancy,
          // not cumulative token cost (ADR-G3).
        }

        await promptDone;
        return { calls: [...calls.values()].sort((a, b) => a.seq - b.seq), reply };
      });
    });

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(
          new AcpHarnessError(
            `agent '${this.agent.id}' exceeded the ${this.timeoutMs} ms task budget`,
          ),
        );
      }, this.timeoutMs);
      // Do not hold the event loop open for the timer.
      t.unref();
    });

    return Promise.race([run, timeout, spawnFailure]);
  }

  // -------------------------------------------------------------------------
  // Trace assembly (ADR-G3/G4)
  // -------------------------------------------------------------------------

  private buildTrace(
    task: AcpEvalTask,
    observed: ObservedSession,
    targetToolNames: readonly string[],
    replyPattern: RegExp | undefined,
  ): TaskTrace {
    const folded = observed.calls;
    const chosenTools: string[] = [];
    const provenanceEvents: ProvenanceEvent[] = [];
    const priorReturns: unknown[] = [];
    let degraded = false;

    if (folded.length === 0 && task.expectNoToolCalls !== true) {
      // No-contact: the agent never issued a tool call. mcpServers connection
      // is SHOULD-strength — detectable, not preventable (ADR-G4). In a
      // negative scenario zero calls is the expected outcome, not a gap.
      degraded = true;
    }

    for (const call of folded) {
      const attributed = attributeToolCall(call.title, targetToolNames);
      if (attributed === null) {
        // Activity we cannot attribute to the target server — cannot certify
        // contact, so the trace is degraded rather than silently trusted.
        degraded = true;
        continue;
      }
      chosenTools.push(attributed);

      if (call.rawInput !== undefined && call.rawInput !== null && typeof call.rawInput === 'object') {
        provenanceEvents.push(
          ...analyzeToolCallProvenance(
            attributed,
            call.rawInput as Record<string, unknown>,
            task.description,
            priorReturns,
          ),
        );
      } else {
        // rawInput is optional on the wire; absence means we cannot compute
        // provenance — mark degraded instead of fabricating events (ADR-G3).
        degraded = true;
      }

      if (call.rawOutput !== undefined) {
        priorReturns.push(call.rawOutput);
      }
    }

    let pass: boolean;
    if (task.expectNoToolCalls === true) {
      // Negative scenario (ADR-G8): any tool call is the failure.
      pass = folded.length === 0;
    } else {
      pass = folded.length === 0 ? false : inferPass(task, chosenTools);
    }
    if (replyPattern !== undefined && !replyPattern.test(observed.reply)) {
      pass = false;
    }

    let claims: ClaimsGrade | undefined;
    if (task.claims !== undefined && task.claims.length > 0) {
      // Only ATTRIBUTED target-tool outputs count as a source: priorReturns is
      // filled solely from calls that passed the attribution ladder above.
      claims = gradeClaims(task.claims, parseClaimsManifest(observed.reply), priorReturns);
      if (claims.passed !== claims.total || claims.extra.length > 0) pass = false;
    }

    const rubric = computePreliminaryRubric(task, chosenTools);
    const subject: EvalSubject =
      this.targetServer.source !== undefined
        ? {
            name: this.targetServer.name,
            source: 'package',
            package: this.targetServer.source.package,
            version: this.targetServer.source.version,
          }
        : { name: this.targetServer.name, source: 'command' };

    return {
      taskId: task.taskId,
      multiStep: task.multiStep,
      lowSignal: task.lowSignal,
      pass,
      tokenCost: null, // ACP exposes context occupancy, not cumulative cost (ADR-G3)
      chosenTools,
      provenanceEvents,
      rubric,
      ...(degraded ? { degraded } : {}),
      isolation: this.isolation,
      subject,
      ...(claims !== undefined ? { claims } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup (ADR-G7)
  // -------------------------------------------------------------------------

  private async cleanup(child: ChildProcess | undefined, scratchCwd: string): Promise<void> {
    if (child !== undefined && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      const exited = new Promise<void>((resolvePromise) => {
        child.once('exit', () => resolvePromise());
      });
      const grace = new Promise<void>((resolvePromise) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolvePromise();
        }, 2_000);
        t.unref();
      });
      await Promise.race([exited, grace]);
    }
    await rm(scratchCwd, { recursive: true, force: true }).catch(() => {
      // Scratch cleanup is best-effort — never mask the task result.
    });
  }
}
