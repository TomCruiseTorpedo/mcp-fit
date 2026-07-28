/**
 * mcp-fit artifact emitter (B-004).
 *
 * Emits compat.json and evals.jsonl; validates each artifact against the
 * published JSON Schemas before writing.
 *
 * Spec: Machine-Readable Output (specs/mcp-fit/spec.md)
 * ADR: ADR-A (docs/adr/ADR-A-scorecard-schema.md)
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Ajv } from 'ajv';
import type { IsolationPosture, Scorecard, TaskTrace } from '../types.js';

// ---------------------------------------------------------------------------
// Schema loading & validator setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '..', '..', 'schemas');

// Load schemas at module initialisation — fast (sync, tiny files), and
// failing early on a missing schema is preferable to late runtime errors.
const compatSchema: object = JSON.parse(
  readFileSync(join(SCHEMAS_DIR, 'compat.schema.json'), 'utf8'),
) as object;
const evalsSchema: object = JSON.parse(
  readFileSync(join(SCHEMAS_DIR, 'evals.schema.json'), 'utf8'),
) as object;

// strict: false — suppress ajv warnings about unknown keywords in the
// 2019-09 schema meta-schema and our use of `description` everywhere.
const ajv = new Ajv({ strict: false });
const _validateCompat = ajv.compile(compatSchema);
const _validateEvals = ajv.compile(evalsSchema);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of validating an artifact against its JSON Schema. */
export interface ValidationResult {
  valid: boolean;
  /** Human-readable error messages; empty when valid. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Schema validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate any value against `compat.schema.json`.
 * Does NOT throw — returns a result object for programmatic use.
 */
export function validateScorecardSchema(data: unknown): ValidationResult {
  const valid = _validateCompat(data);
  return {
    valid,
    errors: valid
      ? []
      : (_validateCompat.errors ?? []).map(
          (e: { instancePath: string; message?: string }) =>
            `${e.instancePath || '(root)'} ${e.message ?? 'unknown error'}`,
        ),
  };
}

/**
 * Validate any value against `evals.schema.json`.
 * Does NOT throw — returns a result object for programmatic use.
 */
export function validateTaskTraceSchema(data: unknown): ValidationResult {
  const valid = _validateEvals(data);
  return {
    valid,
    errors: valid
      ? []
      : (_validateEvals.errors ?? []).map(
          (e: { instancePath: string; message?: string }) =>
            `${e.instancePath || '(root)'} ${e.message ?? 'unknown error'}`,
        ),
  };
}

// ---------------------------------------------------------------------------
// Isolation posture
// ---------------------------------------------------------------------------

/**
 * Facts observed about how a scan was actually run. Each field is something a
 * caller can only set by having genuinely done the thing.
 *
 * Deliberately evidence-shaped rather than a posture the caller asserts: the
 * point of the field is to report what happened, and a caller who can simply
 * declare 'namespace' has been handed the same false-claim problem this
 * replaces. Fields are added as the isolation stack grows.
 */
export interface IsolationEvidence {
  /** The spawned server got a fresh, disposable HOME and cwd. */
  disposableHome?: boolean;
  /** An OS-level sandbox wrapped the spawn — the mechanism name, e.g. 'sandbox-exec'. */
  osSandbox?: string | null;
  /**
   * An in-sandbox self-test ran in the real spawn context and CONFIRMED
   * containment (attempted a host-file read and an external resolve, both
   * refused). False means the test ran and containment was absent — which
   * downgrades the reported level rather than being ignored.
   */
  selfTestVerified?: boolean;
}

/**
 * Determine the isolation posture from observed evidence.
 *
 * Returns 'none' when handed nothing, because that is the truth today: the
 * eval sandbox is an in-process tool-NAME denylist sharing the host's PID,
 * filesystem, network and user. This function is the seam the isolation stack
 * writes into — as real containment lands, the evidence it passes changes the
 * answer, and no constant anywhere needs editing to keep the artifact honest.
 */
export function detectIsolationPosture(evidence: IsolationEvidence = {}): IsolationPosture {
  const { disposableHome = false, osSandbox = null, selfTestVerified } = evidence;

  // A self-test that RAN and failed is the strongest signal available: it
  // measured the real spawn context and found no containment. It overrides
  // every other claim, because the other fields describe what was attempted
  // and this one describes what was achieved.
  if (selfTestVerified === false) {
    return {
      level: 'none',
      mechanism:
        'containment self-test FAILED in the real spawn context — a sentinel host-file ' +
        'read or external resolve succeeded',
      residual:
        'everything: the target server can reach the host filesystem and network as this user',
    };
  }

  if (typeof osSandbox === 'string' && osSandbox.length > 0) {
    return {
      level: 'namespace',
      mechanism: `OS-level sandbox (${osSandbox})`,
      residual:
        'whatever the sandbox profile permits; coverage is platform-specific and its ' +
        'failure mode is silent — read the profile, do not assume it',
    };
  }

  if (disposableHome) {
    return {
      level: 'process',
      mechanism: 'separate process with a disposable HOME and cwd',
      residual:
        'ABSOLUTE paths still resolve — a disposable HOME cuts HOME-relative reads only. ' +
        'The process runs as this user with full network access',
    };
  }

  return {
    level: 'none',
    mechanism:
      'in-process tool-name denylist only (src/eval/sandbox.ts) — same PID, filesystem, ' +
      'network and user as the CLI',
    residual:
      'a hostile tool under an unrecognised name (e.g. "saveNote", "fetch_url") is not ' +
      'filtered, and nothing constrains the spawned server process itself',
  };
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Validate and write a Scorecard to `outputPath` as `compat.json`.
 *
 * Stamps the isolation posture from `evidence`, overwriting anything already on
 * the scorecard: the artifact must report what the emitter can substantiate,
 * not what a caller would like it to say.
 *
 * @throws if the scorecard does not validate against compat.schema.json.
 * @throws if the write fails.
 */
export async function emitCompat(
  scorecard: Scorecard,
  outputPath: string,
  evidence: IsolationEvidence = {},
): Promise<void> {
  const stamped: Scorecard = {
    ...scorecard,
    isolationPosture: detectIsolationPosture(evidence),
  };
  const result = validateScorecardSchema(stamped);
  if (!result.valid) {
    throw new Error(
      `Scorecard does not validate against compat.schema.json:\n` +
        result.errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
  await writeFile(outputPath, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
}

/**
 * Validate and write an array of TaskTraces to `outputPath` as `evals.jsonl`
 * (one JSON object per line, newline-terminated).
 *
 * Validates every trace before writing any — the file is either fully written
 * or not written at all (write happens after all validation passes).
 *
 * @throws if any trace does not validate against evals.schema.json.
 * @throws if the write fails.
 */
export async function emitEvals(traces: TaskTrace[], outputPath: string): Promise<void> {
  // Validate all traces up front so we never write a partial file.
  for (const trace of traces) {
    const result = validateTaskTraceSchema(trace);
    if (!result.valid) {
      throw new Error(
        `TaskTrace "${trace.taskId}" does not validate against evals.schema.json:\n` +
          result.errors.map((e) => `  • ${e}`).join('\n'),
      );
    }
  }

  if (traces.length === 0) {
    await writeFile(outputPath, '', 'utf8');
    return;
  }

  const content = traces.map((t) => JSON.stringify(t)).join('\n') + '\n';
  await writeFile(outputPath, content, 'utf8');
}
