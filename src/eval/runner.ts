/**
 * Eval runner — orchestrates task execution, collects traces, and writes
 * evals.jsonl.
 *
 * Usage:
 *   const runner = new EvalRunner(harness);
 *   const traces = await runner.run(tasks, proxy);
 *   await emitEvals(traces, 'evals.jsonl');
 *
 * Spec: Dynamic Eval (specs/mcp-fit/spec.md §Requirement: Dynamic Eval)
 * Owns: src/eval/runner.ts
 */

import { readFile } from 'node:fs/promises';
import type { TaskTrace } from '../types.js';
import type { McpProxy } from '../connect/proxy.js';
import { createSandbox } from './sandbox.js';
import type { Harness, EvalTask } from './harness.js';

// ---------------------------------------------------------------------------
// Task corpus loader
// ---------------------------------------------------------------------------

/**
 * Load and validate an eval task corpus from a JSON file.
 *
 * The file is expected to be a JSON array of EvalTask objects
 * (e.g. fixtures/tasks/tasks.json).
 *
 * @throws if the file cannot be read or is not a valid JSON array.
 */
export async function loadTasks(tasksPath: string): Promise<EvalTask[]> {
  let raw: string;
  try {
    raw = await readFile(tasksPath, 'utf8');
  } catch (err) {
    throw new Error(
      `EvalRunner: could not read task corpus from '${tasksPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(
      `EvalRunner: invalid JSON in task corpus '${tasksPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `EvalRunner: task corpus '${tasksPath}' must be a JSON array of task objects`,
    );
  }

  // Basic shape validation
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i] as Record<string, unknown>;
    if (typeof t.taskId !== 'string') {
      throw new Error(`EvalRunner: task at index ${i} is missing 'taskId' (string)`);
    }
    if (typeof t.description !== 'string') {
      throw new Error(`EvalRunner: task '${t.taskId}' is missing 'description' (string)`);
    }
    if (typeof t.multiStep !== 'boolean') {
      throw new Error(`EvalRunner: task '${t.taskId}' is missing 'multiStep' (boolean)`);
    }
    if (typeof t.lowSignal !== 'boolean') {
      throw new Error(`EvalRunner: task '${t.taskId}' is missing 'lowSignal' (boolean)`);
    }
  }

  return parsed as EvalTask[];
}

// ---------------------------------------------------------------------------
// EvalRunner
// ---------------------------------------------------------------------------

/** Options for EvalRunner.run(). */
export interface RunOptions {
  /**
   * Maximum number of tasks to run. Omit or pass Infinity to run all.
   * Useful for smoke tests or cost-capping during development.
   */
  limit?: number;
}

/**
 * EvalRunner — coordinates the eval loop.
 *
 * For each task:
 *   1. Build a sandbox from the proxy (allowed tools = all proxy tools).
 *   2. Invoke harness.runTask(task, proxy, sandbox).
 *   3. Collect the TaskTrace.
 *
 * The runner is intentionally sequential (not parallel) so that per-task
 * token cost and provenance are unambiguous.
 */
export class EvalRunner {
  constructor(private readonly harness: Harness) {}

  /**
   * Run a task corpus against a proxied server.
   *
   * @param tasks   Task list from loadTasks().
   * @param proxy   Connected re-presentation proxy (B-001).
   * @param options Optional run options.
   * @returns       Array of TaskTrace objects, one per task.
   */
  async run(
    tasks: EvalTask[],
    proxy: McpProxy,
    options: RunOptions = {},
  ): Promise<TaskTrace[]> {
    const limit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : tasks.length;

    const subset = tasks.slice(0, limit);
    const traces: TaskTrace[] = [];

    // Build the allowed tool set from the proxy (all server tools)
    const serverTools = await proxy.listTools();
    const allowedToolNames = new Set(serverTools.map((t) => t.name));

    for (const task of subset) {
      // Fresh sandbox per task (isolated scratch space, no bleed between tasks)
      const sandbox = createSandbox(proxy, allowedToolNames);

      const trace = await this.harness.runTask(task, proxy, sandbox);
      traces.push(trace);
    }

    return traces;
  }
}
