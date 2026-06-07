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
import type { Scorecard, TaskTrace } from '../types.js';

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
// Emitters
// ---------------------------------------------------------------------------

/**
 * Validate and write a Scorecard to `outputPath` as `compat.json`.
 *
 * @throws if the scorecard does not validate against compat.schema.json.
 * @throws if the write fails.
 */
export async function emitCompat(scorecard: Scorecard, outputPath: string): Promise<void> {
  const result = validateScorecardSchema(scorecard);
  if (!result.valid) {
    throw new Error(
      `Scorecard does not validate against compat.schema.json:\n` +
        result.errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
  await writeFile(outputPath, JSON.stringify(scorecard, null, 2) + '\n', 'utf8');
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
