/**
 * Eval harness — Harness interface + ClaudeHarness implementation (ADR-B).
 *
 * ADR-B contract:
 *   Harness.runTask(task, toolset, sandbox): Promise<TaskTrace>
 *   - toolset: tool definitions from the re-presentation proxy
 *   - sandbox: enforces capability restrictions during execution
 *   - returns a normalised TaskTrace (chosen tools, token cost, pass/fail,
 *     provenance events)
 *
 * No Claude-specific calls leak outside this file. The ClaudeHarness is the
 * sole v1 implementation; v1.1 adds an ACP adapter without changing the
 * interface.
 *
 * Spec: Dynamic Eval (specs/mcp-fit/spec.md)
 * ADR: ADR-B (docs/adr/ADR-B-harness-interface.md)
 */

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_SCORE_MODEL } from '../models.js';
import type {
  MessageParam,
  ToolUseBlock,
  ToolResultBlockParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import type {
  TaskTrace,
  ProvenanceEvent,
  ProvenanceEventType,
} from '../types.js';
import type { Toolset } from './sandbox.js';
import type { Sandbox } from './sandbox.js';

// ---------------------------------------------------------------------------
// EvalTask — input task spec from the corpus
// ---------------------------------------------------------------------------

/**
 * A task from the eval corpus.
 * Loaded from fixtures/tasks/tasks.json.
 */
export interface EvalTask {
  taskId: string;
  description: string;
  multiStep: boolean;
  lowSignal: boolean;
  /** Tools expected to be called (used for pass/fail and rubric scoring). */
  expectedTools?: string[];
  /** Human-readable criteria the judge uses for rubric scoring. */
  verificationCriteria?: string;
  /** Optional step decomposition for multi-step tasks. */
  steps?: Array<{
    stepId: string;
    description: string;
    expectedTool: string;
  }>;
}

// ---------------------------------------------------------------------------
// Harness interface (ADR-B)
// ---------------------------------------------------------------------------

/**
 * The pluggable harness interface.
 *
 * v1 implementation: ClaudeHarness (this file).
 * v1.1 target: a single ACP adapter for cross-harness coverage.
 */
export interface Harness {
  runTask(task: EvalTask, toolset: Toolset, sandbox: Sandbox): Promise<TaskTrace>;
}

// ---------------------------------------------------------------------------
// Provenance analysis
// ---------------------------------------------------------------------------

/**
 * Classify the provenance of a single tool argument.
 *
 * Algorithm (v1 heuristic):
 *   1. If the value (as a string) appears verbatim in the task description → 'literal'.
 *   2. If the value appears in any prior tool return (serialised) → 'traced'.
 *   3. Otherwise → 'fabricated'.
 *
 * String values are compared directly; other types are JSON-serialised.
 */
export function classifyProvenance(
  value: unknown,
  taskDescription: string,
  priorReturns: unknown[],
): ProvenanceEventType {
  const strValue = typeof value === 'string' ? value : JSON.stringify(value);

  // Literal: the value appears verbatim in the task description
  if (strValue.length > 0 && taskDescription.includes(strValue)) {
    return 'literal';
  }

  // Traced: the value appears in any prior tool return
  for (const ret of priorReturns) {
    const retStr = typeof ret === 'string' ? ret : JSON.stringify(ret);
    if (strValue.length > 0 && retStr.includes(strValue)) {
      return 'traced';
    }
  }

  return 'fabricated';
}

/**
 * Analyse all arguments of a tool call and emit ProvenanceEvents.
 *
 * Called immediately before the tool result is added to priorReturns so that
 * the current call's own output is not treated as a source for its own inputs.
 */
export function analyzeToolCallProvenance(
  toolName: string,
  args: Record<string, unknown>,
  taskDescription: string,
  priorReturns: unknown[],
): ProvenanceEvent[] {
  return Object.entries(args).map(([param, value]) => ({
    type: classifyProvenance(value, taskDescription, priorReturns),
    tool: toolName,
    param,
    value,
  }));
}

// ---------------------------------------------------------------------------
// Rubric scoring (preliminary — B-006 owns the LLM-judge loop)
// ---------------------------------------------------------------------------

/**
 * Compute a preliminary rubric score based on tool selection accuracy.
 *
 * B-006 will replace/augment this with a full LLM-judge contract-rubric loop.
 * This function provides a cheap, deterministic score that validates the shape
 * of the rubric output until B-006 lands.
 *
 * Scoring logic:
 *   - All expected tools called → 9
 *   - Some expected tools called → proportional (4–8)
 *   - No expected tools called → 2
 *   - No expected tools defined → 5 (unknown quality)
 */
export function computePreliminaryRubric(
  task: EvalTask,
  chosenTools: string[],
): { score: number; round: number } {
  if (!task.expectedTools || task.expectedTools.length === 0) {
    return { score: 5, round: 1 };
  }

  const chosen = new Set(chosenTools);
  const expected = task.expectedTools;
  const matched = expected.filter((t) => chosen.has(t)).length;
  const ratio = matched / expected.length;

  let score: number;
  if (ratio === 1) {
    score = 9;
  } else if (ratio >= 0.5) {
    score = Math.round(4 + ratio * 4); // 6–8
  } else if (ratio > 0) {
    score = 4;
  } else {
    score = 2;
  }

  return { score, round: 1 };
}

// ---------------------------------------------------------------------------
// Helper: convert a ToolDef to the Anthropic API tools format
// ---------------------------------------------------------------------------

function toAnthropicTool(tool: {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: unknown; required?: string[] };
}): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: {
      type: 'object',
      properties: tool.inputSchema.properties ?? null,
      required: tool.inputSchema.required ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: infer pass/fail from chosen tools vs expected
// ---------------------------------------------------------------------------

function inferPass(task: EvalTask, chosenTools: string[]): boolean {
  if (!task.expectedTools || task.expectedTools.length === 0) {
    // No expected tools defined — can't determine pass
    return chosenTools.length > 0;
  }
  // Pass if all expected tools were called (in any order)
  const chosen = new Set(chosenTools);
  return task.expectedTools.every((t) => chosen.has(t));
}

// ---------------------------------------------------------------------------
// ClaudeHarness
// ---------------------------------------------------------------------------

/** Options for constructing a ClaudeHarness. */
export interface ClaudeHarnessOptions {
  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Inject a pre-built Anthropic client (useful for tests). */
  client?: Anthropic;
  /** Model to use. Defaults to {@link DEFAULT_SCORE_MODEL} (fast + cheap). */
  model?: string;
  /** Maximum conversation turns before giving up. Default 10. */
  maxTurns?: number;
  /** Max tokens per API call. Default 1024. */
  maxTokens?: number;
}

/**
 * v1 harness implementation using the Claude Anthropic SDK.
 *
 * All Claude-specific logic is contained here (ADR-B). Tests inject a mock
 * client via `options.client` to avoid live API calls.
 */
export class ClaudeHarness implements Harness {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly maxTokens: number;

  constructor(options: ClaudeHarnessOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey ?? process.env['ANTHROPIC_API_KEY'] });
    this.model = options.model ?? DEFAULT_SCORE_MODEL;
    this.maxTurns = options.maxTurns ?? 10;
    this.maxTokens = options.maxTokens ?? 1024;
  }

  /**
   * Run a single eval task against the sandbox and return a TaskTrace.
   *
   * The harness:
   *   1. Builds a Claude `tools` array from `sandbox.listTools()`.
   *   2. Drives a conversation loop: user message → tool_use → tool_result → ...
   *   3. Tracks chosen tools, token cost, and provenance events.
   *   4. Computes a preliminary rubric score.
   */
  async runTask(
    task: EvalTask,
    toolset: Toolset,
    sandbox: Sandbox,
  ): Promise<TaskTrace> {
    // toolset is used for description discovery (list); sandbox for execution.
    // In v1, we list from sandbox (which already wraps toolset with restrictions).
    void toolset; // intentionally unused — sandbox wraps toolset

    const toolDefs = await sandbox.listTools();
    const anthropicTools = toolDefs.map(toAnthropicTool);

    // Prompt caching: tag the last tool definition so the (stable) toolset
    // prefix is cached across turns — and across tasks that share the same
    // toolset. Cache reads cost ~0.1x input price. Silently no-ops when the
    // toolset is below the model's minimum cacheable prefix; verify it is
    // actually caching via usage.cache_read_input_tokens.
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools[anthropicTools.length - 1];
      if (lastTool) lastTool.cache_control = { type: 'ephemeral' };
    }

    const messages: MessageParam[] = [
      { role: 'user', content: task.description },
    ];

    const chosenTools: string[] = [];
    const provenanceEvents: ProvenanceEvent[] = [];
    const priorReturns: unknown[] = [];
    let totalTokens = 0;
    let pass = false;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        messages,
      });

      const usage = response.usage;
      // Include cached tokens — with prompt caching, input_tokens is only the
      // *uncached* remainder, so total = input + output + cache_creation + cache_read.
      totalTokens +=
        (usage?.input_tokens ?? 0) +
        (usage?.output_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0);

      if (response.stop_reason === 'end_turn') {
        // Agent completed without a pending tool call
        pass = inferPass(task, chosenTools);
        break;
      }

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use',
        );

        const toolResultContents: ToolResultBlockParam[] = [];

        for (const tu of toolUseBlocks) {
          chosenTools.push(tu.name);

          const args =
            tu.input != null && typeof tu.input === 'object'
              ? (tu.input as Record<string, unknown>)
              : {};

          // Analyse provenance before adding this tool's result to priorReturns
          const events = analyzeToolCallProvenance(
            tu.name,
            args,
            task.description,
            priorReturns,
          );
          provenanceEvents.push(...events);

          // Execute the tool through the sandbox
          let toolResult: unknown;
          let isError = false;
          try {
            toolResult = await sandbox.callTool(tu.name, args);
          } catch (err) {
            isError = true;
            toolResult = { error: err instanceof Error ? err.message : String(err) };
          }

          // Record this result for future provenance checks
          priorReturns.push(toolResult);

          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(toolResult),
            is_error: isError,
          });
        }

        // Append assistant response and tool results to conversation
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResultContents });
      } else {
        // Unexpected stop reason — treat as done
        pass = inferPass(task, chosenTools);
        break;
      }
    }

    const rubric = computePreliminaryRubric(task, chosenTools);

    return {
      taskId: task.taskId,
      multiStep: task.multiStep,
      lowSignal: task.lowSignal,
      pass,
      tokenCost: totalTokens,
      chosenTools,
      provenanceEvents,
      rubric,
    };
  }
}
