/**
 * Contract-rubric instance-specific rubric loop (B-006).
 *
 * Algorithm (from RubricRefine §4, adapted to provider-side contracts):
 *   Phase 1 — Rubric generation:
 *     A verifier LLM generates a task- and registry-specific rubric
 *     (ordered list of criteria) from the task description + tool list.
 *   Phase 2 — Scoring loop:
 *     The judge scores the agent's trace against the rubric (1–10).
 *     Early-stops when score == 10 (perfect) or patience exhausted.
 *   Variance:
 *     Run the scoring loop N times on a sample; report mean ± stdev.
 *     Calibrated for top-bin reliability (score ≥ 8) only.
 *
 * Spec: Scorecard — stochastic eval score with variance
 * ADR: ADR-B (harness interface), ADR-C (weights)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { EvalTask } from '../eval/harness.js';
import type { TaskTrace } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single rubric criterion. */
export interface RubricCriterion {
  id: string;
  description: string;
  /** Weight 1–3; higher = more important. */
  weight: number;
}

/** A generated rubric for a specific task + server context. */
export interface TaskRubric {
  taskId: string;
  criteria: RubricCriterion[];
}

/** Result of a single judge scoring pass. */
export interface JudgeScore {
  score: number;   // 1–10
  round: number;   // which round this was produced in
  rationale: string;
}

/** Aggregated result after N scoring rounds. */
export interface RubricLoopResult {
  /** Ordinal score 1–10 (mean across rounds). */
  score: number;
  /** Round at which scoring completed (early-stop or patience exhausted). */
  round: number;
  /** Mean score across all rounds. */
  mean: number;
  /** Standard deviation across all rounds. */
  stdev: number;
  /** Number of rounds run. */
  n: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for the rubric loop. */
export interface RubricLoopOptions {
  /** Pre-built Anthropic client (useful for tests). */
  client?: Anthropic;
  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /**
   * Model for rubric generation and scoring.
   * Defaults to claude-3-5-haiku-20241022 (fast + cheap).
   */
  model?: string;
  /**
   * Maximum number of scoring rounds before taking the average.
   * Early-stop at score == 10 or patience exhausted. Default 3.
   */
  maxRounds?: number;
  /**
   * Patience: max rounds without a score increase before stopping.
   * Default 2.
   */
  patience?: number;
  /** Max tokens per LLM call. Default 512. */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clamp a value to the 1–10 ordinal range. */
function clampScore(s: number): number {
  return Math.min(10, Math.max(1, Math.round(s)));
}

/** Compute mean of an array of numbers. Returns 0 for empty arrays. */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Compute population standard deviation. Returns 0 for < 2 values. */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Extract the first integer 1–10 from a string, or null. */
function extractScore(text: string): number | null {
  // Look for patterns like "Score: 7", "7/10", "score is 7", "I give this a 7"
  const patterns = [
    /\bscore[:\s]+(\d{1,2})\b/i,
    /\b(\d{1,2})\s*\/\s*10\b/,
    /\bgive[s]?\s+(?:this\s+)?(?:a\s+)?(\d{1,2})\b/i,
    /\brating[:\s]+(\d{1,2})\b/i,
    /^(\d{1,2})\s*$/m,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const n = parseInt(m[1] ?? '0', 10);
      if (n >= 1 && n <= 10) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 1: Rubric generation
// ---------------------------------------------------------------------------

/**
 * Generate an instance-specific rubric for the given task + server tool list.
 *
 * The generated rubric is a short ordered list of weighted criteria tailored
 * to what the task requires and what the server provides.
 *
 * @param client  Anthropic client.
 * @param model   Model identifier.
 * @param task    Eval task.
 * @param toolNames  Names of tools the server exposes.
 * @param maxTokens  Token budget for the generation call.
 */
export async function generateRubric(
  client: Anthropic,
  model: string,
  task: EvalTask,
  toolNames: readonly string[],
  maxTokens: number,
): Promise<TaskRubric> {
  const toolList = toolNames.length > 0
    ? toolNames.join(', ')
    : '(no tools available)';

  const prompt = `You are a judge evaluating how well an AI agent used an MCP server to complete a task.

TASK: ${task.description}
AVAILABLE TOOLS: ${toolList}
${task.expectedTools ? `EXPECTED TOOLS: ${task.expectedTools.join(', ')}` : ''}
${task.verificationCriteria ? `VERIFICATION CRITERIA: ${task.verificationCriteria}` : ''}

Generate a concise rubric for scoring an agent's performance on this task.
Output exactly 3-5 criteria in this JSON format (no other text):
{
  "criteria": [
    {"id": "c1", "description": "<criterion>", "weight": <1-3>},
    ...
  ]
}

Criteria should reflect:
1. Whether the agent called the right tool(s) for the task
2. Whether multi-step tasks were executed in the correct order
3. Whether the agent's reasoning and argument choices were appropriate
Higher weight = more important for this task.`;

  let responseText: string;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    responseText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    // Return a minimal default rubric if the API call fails
    return {
      taskId: task.taskId,
      criteria: [
        { id: 'c1', description: 'Agent called the correct tool(s)', weight: 3 },
        { id: 'c2', description: 'Agent arguments were appropriate', weight: 2 },
        { id: 'c3', description: 'Task objective was achieved', weight: 2 },
      ],
    };
  }

  // Parse the JSON response, falling back to a default rubric on parse failure
  try {
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON found');
    const parsed = JSON.parse(jsonMatch[0]) as { criteria?: unknown[] };
    if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
      throw new Error('empty criteria array');
    }
    const criteria: RubricCriterion[] = (parsed.criteria as Array<Record<string, unknown>>).map(
      (c, i) => ({
        id: typeof c['id'] === 'string' ? c['id'] : `c${i + 1}`,
        description: typeof c['description'] === 'string' ? c['description'] : 'criterion',
        weight: typeof c['weight'] === 'number' ? Math.min(3, Math.max(1, Math.round(c['weight']))) : 2,
      }),
    );
    return { taskId: task.taskId, criteria };
  } catch {
    return {
      taskId: task.taskId,
      criteria: [
        { id: 'c1', description: 'Agent called the correct tool(s)', weight: 3 },
        { id: 'c2', description: 'Agent arguments were appropriate', weight: 2 },
        { id: 'c3', description: 'Task objective was achieved', weight: 2 },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Scoring
// ---------------------------------------------------------------------------

/**
 * Score a TaskTrace against a TaskRubric in a single round.
 *
 * @param client     Anthropic client.
 * @param model      Model identifier.
 * @param rubric     Generated rubric.
 * @param trace      The agent's execution trace.
 * @param round      Current round number (for bookkeeping).
 * @param maxTokens  Token budget.
 */
export async function scoreTrace(
  client: Anthropic,
  model: string,
  rubric: TaskRubric,
  trace: TaskTrace,
  round: number,
  maxTokens: number,
): Promise<JudgeScore> {
  const criteriaText = rubric.criteria
    .map((c) => `  [weight ${c.weight}] ${c.description}`)
    .join('\n');

  const traceText = [
    `Tools called: ${trace.chosenTools.join(' → ') || '(none)'}`,
    `Pass: ${trace.pass}`,
    `Token cost: ${trace.tokenCost}`,
    trace.provenanceEvents.length > 0
      ? `Provenance: ${trace.provenanceEvents.filter((e) => e.type === 'fabricated').length} fabricated / ${trace.provenanceEvents.length} total`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `You are a judge scoring an AI agent's performance on an MCP server task.

RUBRIC CRITERIA:
${criteriaText}

AGENT EXECUTION TRACE:
${traceText}

Score the agent's performance on a scale of 1-10 where:
  10 = perfect execution, all criteria met fully
  7-9 = good performance, most criteria met
  4-6 = partial success, some criteria met
  1-3 = poor performance, few or no criteria met

Respond with a brief rationale (1-2 sentences) and then your score.
Format: "[rationale]. Score: [1-10]"`;

  let responseText: string;
  let rationale = 'Unable to score';
  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    responseText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    rationale = responseText.slice(0, 200);
  } catch {
    // Return a score derived from pass/fail if API fails
    const fallbackScore = trace.pass ? 7 : 3;
    return { score: fallbackScore, round, rationale: 'API error; fallback score from pass/fail' };
  }

  const extracted = extractScore(responseText);
  const score = extracted !== null ? clampScore(extracted) : (trace.pass ? 7 : 3);

  return { score, round, rationale };
}

// ---------------------------------------------------------------------------
// Main entry point: rubric loop
// ---------------------------------------------------------------------------

/**
 * Run the full contract-rubric loop for a single task trace.
 *
 * 1. Generate an instance-specific rubric (once per task).
 * 2. Score the trace up to `maxRounds` times (early-stop at 10 or patience).
 * 3. Return aggregated result with mean, stdev, and round count.
 *
 * @param task        The eval task.
 * @param trace       The agent's execution trace.
 * @param toolNames   Tool names the server exposes (for rubric generation).
 * @param options     Loop configuration.
 */
export async function runRubricLoop(
  task: EvalTask,
  trace: TaskTrace,
  toolNames: readonly string[],
  options: RubricLoopOptions = {},
): Promise<RubricLoopResult> {
  const client =
    options.client ??
    new Anthropic({ apiKey: options.apiKey ?? process.env['ANTHROPIC_API_KEY'] });
  const model = options.model ?? 'claude-3-5-haiku-20241022';
  const maxRounds = options.maxRounds ?? 3;
  const patience = options.patience ?? 2;
  const maxTokens = options.maxTokens ?? 512;

  // Phase 1: generate rubric
  const rubric = await generateRubric(client, model, task, toolNames, maxTokens);

  // Phase 2: scoring loop
  const scores: number[] = [];
  let staleRounds = 0;
  let lastScore = -1;
  let finalRound = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const result = await scoreTrace(client, model, rubric, trace, round, maxTokens);
    scores.push(result.score);
    finalRound = round;

    // Early-stop at perfect score
    if (result.score === 10) {
      break;
    }

    // Patience: stop if no improvement over last round
    if (result.score <= lastScore) {
      staleRounds++;
      if (staleRounds >= patience) {
        break;
      }
    } else {
      staleRounds = 0;
    }
    lastScore = result.score;
  }

  const meanScore = Math.round(mean(scores) * 10) / 10;
  const stdevScore = Math.round(stdev(scores) * 100) / 100;

  return {
    score: clampScore(Math.round(meanScore)),
    round: finalRound,
    mean: meanScore,
    stdev: stdevScore,
    n: scores.length,
  };
}
