/**
 * A2A card-scorecard artifact emitter (ADR-F).
 *
 * Emits card-compat.json; validates the artifact against
 * schemas/card-compat.schema.json before writing. Mirrors the MCP-side
 * emitter conventions (src/report/emit.ts).
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Ajv } from 'ajv';
import type { ValidationResult } from '../report/emit.js';
import type { CardScorecard } from './card-types.js';

// ---------------------------------------------------------------------------
// Schema loading & validator setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '..', '..', 'schemas');

const cardCompatSchema: object = JSON.parse(
  readFileSync(join(SCHEMAS_DIR, 'card-compat.schema.json'), 'utf8'),
) as object;

// strict: false — same rationale as src/report/emit.ts (description keywords).
const ajv = new Ajv({ strict: false });
const _validateCardCompat = ajv.compile(cardCompatSchema);

// ---------------------------------------------------------------------------
// Schema validation helper
// ---------------------------------------------------------------------------

/**
 * Validate any value against `card-compat.schema.json`.
 * Does NOT throw — returns a result object for programmatic use.
 */
export function validateCardScorecardSchema(data: unknown): ValidationResult {
  const valid = _validateCardCompat(data);
  return {
    valid,
    errors: valid
      ? []
      : (_validateCardCompat.errors ?? []).map(
          (e: { instancePath: string; message?: string }) =>
            `${e.instancePath || '(root)'} ${e.message ?? 'unknown error'}`,
        ),
  };
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Validate and write a CardScorecard to `outputPath` as `card-compat.json`.
 *
 * @throws if the scorecard does not validate against card-compat.schema.json.
 * @throws if the write fails.
 */
export async function emitCardCompat(
  scorecard: CardScorecard,
  outputPath: string,
): Promise<void> {
  const result = validateCardScorecardSchema(scorecard);
  if (!result.valid) {
    throw new Error(
      `Card scorecard does not validate against card-compat.schema.json:\n` +
        result.errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
  await writeFile(outputPath, JSON.stringify(scorecard, null, 2) + '\n', 'utf8');
}
