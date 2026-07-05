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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import type { ProvenanceEvent, TaskTrace } from '../types.js';
import type { EvalTask, Harness } from './harness.js';
import { analyzeToolCallProvenance, computePreliminaryRubric } from './harness.js';
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
}

/** Options for constructing an AcpHarness. */
export interface AcpHarnessOptions {
  /** Which ACP agent to drive (see acp-agents.ts ACP_AGENTS). */
  agent: AcpAgentSpec;
  /** The MCP server under evaluation, passed to the agent via session/new. */
  targetServer: TargetServerSpec;
  /** Wall-clock budget per task before the run is aborted. Default 120 000 ms. */
  timeoutMs?: number;
}

/** Thrown on spawn/protocol failures and timeouts (ADR-G7). */
export class AcpHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpHarnessError';
  }
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

  constructor(options: AcpHarnessOptions) {
    this.agent = options.agent;
    this.targetServer = options.targetServer;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * Run one eval task by driving the ACP agent subprocess.
   *
   * 1. Spawn the agent; wire an ndjson JSON-RPC stream over its stdio.
   * 2. initialize → session/new (scratch cwd + the target MCP server).
   * 3. Prompt with the task description; fold tool_call updates until stop.
   * 4. Attribute calls to target tools; compute provenance over rawInput;
   *    emit a TaskTrace with tokenCost: null (ADR-G3) and degraded flags.
   */
  async runTask(task: EvalTask, toolset: Toolset, sandbox: Sandbox): Promise<TaskTrace> {
    void toolset; // sandbox wraps toolset; used only for the tool-name universe

    const targetToolNames = (await sandbox.listTools()).map((t) => t.name);
    const scratchCwd = await mkdtemp(join(tmpdir(), 'mcp-fit-acp-'));

    const child = spawn(this.agent.command, this.agent.args, {
      env: { ...process.env, ...this.agent.env },
      stdio: ['pipe', 'pipe', 'inherit'], // agent stderr passes through (ADR-G7)
    });

    try {
      const folded = await this.driveSession(child, task, scratchCwd);
      return this.buildTrace(task, folded, targetToolNames);
    } finally {
      await this.cleanup(child, scratchCwd);
    }
  }

  // -------------------------------------------------------------------------
  // Session driving
  // -------------------------------------------------------------------------

  private async driveSession(
    child: ChildProcess,
    task: EvalTask,
    scratchCwd: string,
  ): Promise<FoldedToolCall[]> {
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

        const promptDone = session.prompt(task.description);
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
          }
          // Other update kinds (message/thought chunks, plans, usage_update)
          // are irrelevant to the trace: usage_update reports context
          // occupancy, not cumulative token cost (ADR-G3).
        }

        await promptDone;
        return [...calls.values()].sort((a, b) => a.seq - b.seq);
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
    task: EvalTask,
    folded: FoldedToolCall[],
    targetToolNames: readonly string[],
  ): TaskTrace {
    const chosenTools: string[] = [];
    const provenanceEvents: ProvenanceEvent[] = [];
    const priorReturns: unknown[] = [];
    let degraded = false;

    if (folded.length === 0) {
      // No-contact: the agent never issued a tool call. mcpServers connection
      // is SHOULD-strength — detectable, not preventable (ADR-G4).
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

    const pass = folded.length === 0 ? false : inferPass(task, chosenTools);
    const rubric = computePreliminaryRubric(task, chosenTools);

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
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup (ADR-G7)
  // -------------------------------------------------------------------------

  private async cleanup(child: ChildProcess, scratchCwd: string): Promise<void> {
    if (child.exitCode === null && !child.killed) {
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
