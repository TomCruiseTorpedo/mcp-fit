/**
 * Unit tests for src/fix/ — B-007 acceptance criteria:
 *
 *  1. tsc --noEmit clean                               (ensured by build step)
 *  2. Strawman moves red (error findings) to green (no errors) end to end
 *  3. Behaviour-unchanged assertion holds (inputSchema structure preserved)
 *  4. No-op honesty path: clean server → "no material improvement available"
 *  5. LLM path: mock client response is parsed and applied correctly
 *  6. agentshield scan clean                           (ensured by scan step)
 *
 * No live Anthropic API calls. The Anthropic client is injected as a mock.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpTool, ToolDef } from '../../types.js';
import { lint } from '../../lint/engine.js';
import { isAlreadyClean, buildRuleBasedOverride, rewrite } from '../rewriter.js';
import { revalidate, revalidateTools } from '../revalidate.js';
import { computeDelta, formatDelta } from '../delta.js';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Strawman tools — a direct copy of the anti-pattern signatures from the server. */
const STRAWMAN_TOOLS: McpTool[] = [
  {
    name: 'process',
    description: 'Process data',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['data'],
    },
  },
  {
    name: 'get',
    description: 'Get',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'search',
    description: 'Search for things in the data store. Use this to look up items.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  },
  {
    name: 'find',
    description: 'Find items in the system. Use this to search for content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'change',
    description: 'Change something',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        data: { type: 'string' },
      },
      required: ['id', 'data'],
    },
  },
  {
    name: 'remove',
    description: 'Remove',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

function toToolDefs(tools: McpTool[]): ToolDef[] {
  return tools.map((t) => ({ ...t, findings: [] }));
}

/** Already-clean tools: well-described, structured output, error docs. */
const CLEAN_TOOLS: McpTool[] = [
  {
    name: 'notes_create',
    description: 'Creates a new note. Returns the created note ID. Throws if title is empty.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the note (non-empty).' },
        content: { type: 'string', description: 'Body text for the note.' },
      },
      required: ['title'],
    },
    outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'notes_get',
    description: 'Retrieves a note by ID. Returns null if the note does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note identifier.' },
      },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
  },
  {
    name: 'notes_delete',
    description: 'Deletes a note by ID. Returns an error if the note is not found.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note identifier to delete.' },
      },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
  },
];

// ---------------------------------------------------------------------------
// Helper: count error-severity findings in a LintResult
// ---------------------------------------------------------------------------

function countErrors(lintResult: ReturnType<typeof lint>): number {
  let n = 0;
  for (const t of lintResult.tools) {
    for (const f of t.findings) {
      if (f.severity === 'error') n++;
    }
  }
  return n;
}

function countWarnings(lintResult: ReturnType<typeof lint>): number {
  let n = 0;
  for (const t of lintResult.tools) {
    for (const f of t.findings) {
      if (f.severity === 'warning') n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// isAlreadyClean
// ---------------------------------------------------------------------------

describe('isAlreadyClean', () => {
  it('returns true for a lint result with score >= 9.0 and no errors/warnings', () => {
    const result = lint(CLEAN_TOOLS);
    expect(result.aggregate.lintScore).toBeGreaterThanOrEqual(9.0);
    expect(countErrors(result)).toBe(0);
    expect(countWarnings(result)).toBe(0);
    expect(isAlreadyClean(result)).toBe(true);
  });

  it('returns false for the strawman (has error findings)', () => {
    const result = lint(STRAWMAN_TOOLS);
    expect(countErrors(result)).toBeGreaterThan(0);
    expect(isAlreadyClean(result)).toBe(false);
  });

  it('returns false when score < threshold even with no errors', () => {
    // Create a lint result mock with a low score but no errors
    const result = lint(CLEAN_TOOLS);
    expect(isAlreadyClean(result, 10.1)).toBe(false); // threshold above max
  });
});

// ---------------------------------------------------------------------------
// buildRuleBasedOverride
// ---------------------------------------------------------------------------

describe('buildRuleBasedOverride', () => {
  it('generates param descriptions for missing required param findings', () => {
    const tool = toToolDefs([STRAWMAN_TOOLS[1]!])[0]!; // 'get' tool
    const findings = [
      {
        ruleId: 'no-required-param-description',
        axis: 'param-strictness' as const,
        severity: 'error' as const,
        tool: 'get',
        param: 'id',
        message: 'Required parameter "id" of tool "get" has no description.',
      },
    ];
    const override = buildRuleBasedOverride(tool, findings);
    expect(override).not.toBeNull();
    expect(override!.tool).toBe('get');
    expect(override!.params).toEqual({ id: 'The id for this operation.' });
  });

  it('generates a tool description for no-missing-tool-description finding', () => {
    const tool: ToolDef = {
      name: 'do_thing',
      inputSchema: { type: 'object' },
      findings: [],
    };
    const findings = [
      {
        ruleId: 'no-missing-tool-description',
        axis: 'namespacing' as const,
        severity: 'error' as const,
        tool: 'do_thing',
        message: 'Tool "do_thing" has no description.',
      },
    ];
    const override = buildRuleBasedOverride(tool, findings);
    expect(override).not.toBeNull();
    expect(override!.description).toContain('do thing');
    expect(override!.description).toContain('error');
  });

  it('returns null when no actionable findings exist', () => {
    const tool = toToolDefs([CLEAN_TOOLS[0]!])[0]!;
    const result = buildRuleBasedOverride(tool, []);
    expect(result).toBeNull();
  });

  it('handles multiple required params in one tool', () => {
    const tool = toToolDefs([STRAWMAN_TOOLS[4]!])[0]!; // 'change' with id + data
    const findings = [
      {
        ruleId: 'no-required-param-description',
        axis: 'param-strictness' as const,
        severity: 'error' as const,
        tool: 'change',
        param: 'id',
        message: 'Required parameter "id" of tool "change" has no description.',
      },
      {
        ruleId: 'no-required-param-description',
        axis: 'param-strictness' as const,
        severity: 'error' as const,
        tool: 'change',
        param: 'data',
        message: 'Required parameter "data" of tool "change" has no description.',
      },
    ];
    const override = buildRuleBasedOverride(tool, findings);
    expect(override).not.toBeNull();
    expect(override!.params).toHaveProperty('id');
    expect(override!.params).toHaveProperty('data');
  });
});

// ---------------------------------------------------------------------------
// revalidateTools — behaviour-unchanged assertion
// ---------------------------------------------------------------------------

describe('revalidateTools — behaviour unchanged', () => {
  it('preserves inputSchema structure after applying overrides', () => {
    const tools = toToolDefs(STRAWMAN_TOOLS);
    const overrides = [
      {
        tool: 'get',
        description: 'Retrieves a note by its unique ID. Returns an error if not found.',
        params: { id: 'The unique identifier of the note (e.g., note-1).' },
      },
    ];

    const { tools: rewritten } = revalidateTools(tools, overrides);
    const original = tools.find((t) => t.name === 'get')!;
    const updated = rewritten.find((t) => t.name === 'get')!;

    // Description changed
    expect(updated.description).toBe(
      'Retrieves a note by its unique ID. Returns an error if not found.',
    );
    expect(updated.description).not.toBe(original.description);

    // Param description changed
    expect(updated.inputSchema.properties?.['id']?.['description']).toBe(
      'The unique identifier of the note (e.g., note-1).',
    );

    // BEHAVIOUR UNCHANGED: schema structure intact
    expect(updated.name).toBe(original.name);
    expect(updated.inputSchema.type).toBe('object');
    expect(updated.inputSchema.required).toEqual(['id']);
    expect(updated.inputSchema.properties?.['id']?.['type']).toBe('string');
  });

  it('does not affect tools without overrides', () => {
    const tools = toToolDefs(STRAWMAN_TOOLS);
    const overrides = [{ tool: 'get', description: 'Better description.' }];
    const { tools: rewritten } = revalidateTools(tools, overrides);

    // 'search' tool is untouched
    const original = tools.find((t) => t.name === 'search')!;
    const after = rewritten.find((t) => t.name === 'search')!;
    expect(after.description).toBe(original.description);
    expect(after.inputSchema).toEqual(original.inputSchema);
  });
});

// ---------------------------------------------------------------------------
// Strawman red → green (end-to-end, no LLM)
// ---------------------------------------------------------------------------

describe('strawman red → green (end-to-end with rule-based overrides)', () => {
  it('before: strawman has error-severity findings (red)', () => {
    const before = lint(STRAWMAN_TOOLS);
    expect(countErrors(before)).toBeGreaterThan(0);
    // param-strictness is the problem axis
    expect(before.axisScores['param-strictness'].score).toBeLessThanOrEqual(3);
  });

  it('after: applying rule-based overrides eliminates all errors (green)', () => {
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const before = lint(STRAWMAN_TOOLS);

    // Build rule-based overrides for each tool with error findings
    const overrides = strawmanDefs
      .map((tool) => {
        const toolReport = before.tools.find((r) => r.name === tool.name);
        const errorFindings = toolReport?.findings.filter((f) => f.severity === 'error') ?? [];
        return buildRuleBasedOverride(tool, errorFindings);
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);

    expect(overrides.length).toBeGreaterThan(0);

    // Apply and re-validate
    const { lintResult: after } = revalidateTools(strawmanDefs, overrides);

    // All errors eliminated
    expect(countErrors(after)).toBe(0);

    // param-strictness score improved to max
    expect(after.axisScores['param-strictness'].score).toBe(10);

    // Aggregate score improved
    expect(after.aggregate.weighted).toBeGreaterThan(before.aggregate.weighted);
  });
});

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------

describe('computeDelta', () => {
  it('reports correct per-axis deltas', () => {
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const before = lint(STRAWMAN_TOOLS);

    const overrides = strawmanDefs
      .map((tool) => {
        const toolReport = before.tools.find((r) => r.name === tool.name);
        const errorFindings = toolReport?.findings.filter((f) => f.severity === 'error') ?? [];
        return buildRuleBasedOverride(tool, errorFindings);
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);

    const { lintResult: after } = revalidateTools(strawmanDefs, overrides);
    const delta = computeDelta(before, after);

    // param-strictness improved significantly
    const paramAxis = delta.axes.find((a) => a.axis === 'param-strictness')!;
    expect(paramAxis.delta).toBeGreaterThan(0);
    expect(paramAxis.after).toBeGreaterThan(paramAxis.before);

    // Overall score improved
    expect(delta.scoreDelta).toBeGreaterThan(0);
    expect(delta.hasMaterialImprovement).toBe(true);
    expect(delta.findingsEliminated).toBeGreaterThan(0);
  });

  it('hasMaterialImprovement is false when before === after (unchanged tools)', () => {
    const before = lint(CLEAN_TOOLS);
    const after = lint(CLEAN_TOOLS); // same result
    const delta = computeDelta(before, after);
    expect(delta.scoreDelta).toBe(0);
    expect(delta.findingsEliminated).toBe(0);
    expect(delta.hasMaterialImprovement).toBe(false);
  });

  it('tokenWasteDelta reflects output-leanness axis change', () => {
    const before = lint(STRAWMAN_TOOLS);
    const after = lint(CLEAN_TOOLS); // clean tools have outputSchema → better score
    const delta = computeDelta(before, after);
    // output-leanness: no-output-schema is info-only, so may not change score
    // Just verify the field is a number and matches the axis delta
    const leanAxis = delta.axes.find((a) => a.axis === 'output-leanness')!;
    expect(delta.tokenWasteDelta).toBe(leanAxis.delta);
  });
});

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------

describe('formatDelta', () => {
  it('includes before/after scores in output', () => {
    const before = lint(STRAWMAN_TOOLS);
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const overrides = strawmanDefs
      .map((tool) => {
        const toolReport = before.tools.find((r) => r.name === tool.name);
        const findings = toolReport?.findings.filter((f) => f.severity === 'error') ?? [];
        return buildRuleBasedOverride(tool, findings);
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);
    const { lintResult: after } = revalidateTools(strawmanDefs, overrides);
    const delta = computeDelta(before, after);
    const text = formatDelta(delta);

    expect(text).toContain('Fix-mode delta:');
    expect(text).toContain('→');
    expect(text).toContain('param-strictness');
  });

  it('shows "no material improvement" when there is none', () => {
    const result = lint(CLEAN_TOOLS);
    const delta = computeDelta(result, result);
    const text = formatDelta(delta);
    expect(text).toContain('No material improvement available.');
  });
});

// ---------------------------------------------------------------------------
// rewrite() — no-op honesty path
// ---------------------------------------------------------------------------

describe('rewrite — no-op honesty path', () => {
  it('returns no improvements for an already-clean server', async () => {
    const cleanDefs = toToolDefs(CLEAN_TOOLS);
    const lintResult = lint(CLEAN_TOOLS);
    const result = await rewrite(cleanDefs, lintResult);

    expect(result.hasImprovements).toBe(false);
    expect(result.overrides).toHaveLength(0);
    expect(result.message).toContain('No material improvement available');
  });
});

// ---------------------------------------------------------------------------
// rewrite() — LLM path (mock client)
// ---------------------------------------------------------------------------

describe('rewrite — LLM path with mock client', () => {
  it('uses LLM response when client is injected', async () => {
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const lintResult = lint(STRAWMAN_TOOLS);

    // Mock client: returns well-formed JSON with improved descriptions
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            description: 'Retrieves a note by its unique identifier. Returns an error if not found.',
            params: { id: 'The unique note identifier (e.g., note-1).' },
          }),
        },
      ],
    });
    const mockClient = { messages: { create: mockCreate } } as unknown as Anthropic;

    const result = await rewrite(strawmanDefs, lintResult, { client: mockClient });

    expect(result.hasImprovements).toBe(true);
    expect(result.overrides.length).toBeGreaterThan(0);
    // The mock was called at least once
    expect(mockCreate).toHaveBeenCalled();
  });

  it('falls back to rule-based when LLM returns invalid JSON', async () => {
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const lintResult = lint(STRAWMAN_TOOLS);

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'This is not JSON at all.' }],
    });
    const mockClient = { messages: { create: mockCreate } } as unknown as Anthropic;

    const result = await rewrite(strawmanDefs, lintResult, { client: mockClient });

    // Rule-based fallback should still produce improvements
    expect(result.hasImprovements).toBe(true);
    expect(result.overrides.length).toBeGreaterThan(0);
  });

  it('falls back to rule-based when LLM throws', async () => {
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const lintResult = lint(STRAWMAN_TOOLS);

    const mockCreate = vi.fn().mockRejectedValue(new Error('API timeout'));
    const mockClient = { messages: { create: mockCreate } } as unknown as Anthropic;

    const result = await rewrite(strawmanDefs, lintResult, { client: mockClient });

    // Rule-based fallback should still produce improvements
    expect(result.hasImprovements).toBe(true);
    expect(result.overrides.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end pipeline (rewrite → revalidate → delta) with mock LLM
// ---------------------------------------------------------------------------

describe('full pipeline: strawman red → green via rewrite + revalidate', () => {
  it('moves error count from >0 to 0 using LLM-generated overrides', async () => {
    const strawmanDefs = toToolDefs(STRAWMAN_TOOLS);
    const introspection = {
      server: { name: 'strawman', version: '0.1.0', transport: 'stdio' as const },
      tools: strawmanDefs,
      resources: [],
      prompts: [],
    };

    const lintBefore = lint(STRAWMAN_TOOLS);
    expect(countErrors(lintBefore)).toBeGreaterThan(0);

    // Mock LLM returns improvements keyed by TOOL name in the prompt
    const mockCreate = vi.fn().mockImplementation((params: unknown) => {
      const p = params as { messages: Array<{ content: string }> };
      const prompt = p.messages[0]?.content ?? '';
      // Extract tool name from "TOOL: <name>" line
      const toolMatch = prompt.match(/^TOOL: (\S+)/m);
      const toolName = toolMatch?.[1] ?? '';

      const RESPONSES: Record<string, object> = {
        process: {
          description: 'Creates a new note from the provided data. Returns an error if data is missing.',
          params: { data: 'Note content in "title:content" format.' },
        },
        get: {
          description: 'Retrieves a note by its unique ID. Returns an error if not found.',
          params: { id: 'Unique note identifier (e.g., note-1).' },
        },
        search: {
          description: 'Searches notes by text query. Returns matching note summaries.',
          params: { q: 'Search query string to match against titles and content.' },
        },
        find: {
          description: 'Finds notes by query. Searches titles, content, and tags.',
          params: { query: 'Query string to search for in notes.' },
        },
        change: {
          description: 'Updates an existing note. Returns an error if the note does not exist.',
          params: {
            id: 'Unique note identifier to update.',
            data: 'Patch object (JSON) or replacement content string.',
          },
        },
        remove: {
          description: 'Deletes a note permanently. Returns an error if the note is not found.',
          params: { id: 'Unique note identifier to delete.' },
        },
      };

      const resp = RESPONSES[toolName];
      return Promise.resolve({
        content: [{ type: 'text', text: resp ? JSON.stringify(resp) : '{}' }],
      });
    });

    const mockClient = { messages: { create: mockCreate } } as unknown as Anthropic;

    // Step 1: rewrite
    const { overrides } = await rewrite(strawmanDefs, lintBefore, { client: mockClient });
    expect(overrides.length).toBeGreaterThan(0);

    // Step 2: revalidate
    const { lintResult: lintAfter } = revalidate(introspection, overrides);

    // Step 3: delta
    const delta = computeDelta(lintBefore, lintAfter);

    // Green: no error findings
    expect(countErrors(lintAfter)).toBe(0);

    // param-strictness improved
    expect(lintAfter.axisScores['param-strictness'].score).toBeGreaterThan(
      lintBefore.axisScores['param-strictness'].score,
    );

    // Material improvement confirmed
    expect(delta.hasMaterialImprovement).toBe(true);
    expect(delta.findingsEliminated).toBeGreaterThan(0);
    expect(delta.scoreDelta).toBeGreaterThan(0);
  });
});
