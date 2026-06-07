/**
 * Unit tests for src/connect/proxy.ts
 *
 * Scenarios covered (from spec):
 *   - Transparent passthrough: no overrides → calls and descriptions unchanged
 *   - Description override: tool description is rewritten
 *   - Param description override: param description is rewritten in schema
 *   - Tool invocation unchanged: behaviour transparent regardless of overrides
 *   - Non-overridden tools unaffected
 *   - Runtime override update via setOverrides()
 *   - applyOverridesToIntrospection() standalone helper
 */

import { describe, it, expect, vi } from 'vitest';
import { McpProxy, applyOverridesToIntrospection } from '../proxy.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerIntrospection } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockClient(): Client {
  return {
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'search',
          description: 'Search for items',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'original query desc' },
              limit: { type: 'number', description: 'max results' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_item',
          description: 'Get an item by ID',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'item id' } },
            required: ['id'],
          },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
    }),
  } as unknown as Client;
}

// ---------------------------------------------------------------------------
// Transparent passthrough (no overrides)
// ---------------------------------------------------------------------------

describe('McpProxy — transparent passthrough (no overrides)', () => {
  it('returns original tool descriptions unchanged', async () => {
    const proxy = new McpProxy(makeMockClient());
    const tools = await proxy.listTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('search');
    expect(tools[0].description).toBe('Search for items');
    expect(tools[1].name).toBe('get_item');
    expect(tools[1].description).toBe('Get an item by ID');
  });

  it('returns original param descriptions unchanged', async () => {
    const proxy = new McpProxy(makeMockClient());
    const tools = await proxy.listTools();
    const schema = tools[0].inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties['query'].description).toBe('original query desc');
  });

  it('forwards callTool to the underlying client', async () => {
    const client = makeMockClient();
    const proxy = new McpProxy(client);

    const result = await proxy.callTool('search', { query: 'hello' });

    expect(client.callTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: { query: 'hello' },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'result' }] });
  });
});

// ---------------------------------------------------------------------------
// Description overrides
// ---------------------------------------------------------------------------

describe('McpProxy — description override', () => {
  it('overrides a tool description', async () => {
    const proxy = new McpProxy(makeMockClient(), {
      overrides: [{ tool: 'search', description: 'REWRITTEN tool description' }],
    });
    const tools = await proxy.listTools();
    expect(tools[0].description).toBe('REWRITTEN tool description');
  });

  it('overrides a param description', async () => {
    const proxy = new McpProxy(makeMockClient(), {
      overrides: [{ tool: 'search', params: { query: 'New query description' } }],
    });
    const tools = await proxy.listTools();
    const schema = tools[0].inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties['query'].description).toBe('New query description');
  });

  it('overrides both tool and param description together', async () => {
    const proxy = new McpProxy(makeMockClient(), {
      overrides: [
        {
          tool: 'search',
          description: 'NEW tool desc',
          params: { query: 'NEW param desc' },
        },
      ],
    });
    const tools = await proxy.listTools();
    const schema = tools[0].inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(tools[0].description).toBe('NEW tool desc');
    expect(schema.properties['query'].description).toBe('NEW param desc');
  });

  it('does NOT change callTool behaviour when overrides are active', async () => {
    const client = makeMockClient();
    const proxy = new McpProxy(client, {
      overrides: [{ tool: 'search', description: 'override' }],
    });

    await proxy.callTool('search', { query: 'test' });

    // Underlying client receives the original tool name, unmodified
    expect(client.callTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: { query: 'test' },
    });
  });

  it('leaves non-overridden tools unchanged', async () => {
    const proxy = new McpProxy(makeMockClient(), {
      overrides: [{ tool: 'search', description: 'changed' }],
    });
    const tools = await proxy.listTools();
    const getItem = tools.find((t) => t.name === 'get_item')!;
    expect(getItem.description).toBe('Get an item by ID');
  });

  it('ignores override for a tool that does not exist in the server', async () => {
    const proxy = new McpProxy(makeMockClient(), {
      overrides: [{ tool: 'nonexistent_tool', description: 'ghost' }],
    });
    const tools = await proxy.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.description !== 'ghost')).toBe(true);
  });

  it('does not mutate the original inputSchema', async () => {
    const client = makeMockClient();
    const proxy = new McpProxy(client, {
      overrides: [{ tool: 'search', params: { query: 'mutated?' } }],
    });

    await proxy.listTools();

    // Call again to get the "original" from the mock
    const rawResult = await client.listTools();
    const rawSchema = rawResult.tools[0].inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(rawSchema.properties['query'].description).toBe('original query desc');
  });
});

// ---------------------------------------------------------------------------
// Runtime override management
// ---------------------------------------------------------------------------

describe('McpProxy — setOverrides()', () => {
  it('updates overrides at runtime', async () => {
    const proxy = new McpProxy(makeMockClient());

    // Initially no overrides
    let tools = await proxy.listTools();
    expect(tools[0].description).toBe('Search for items');

    // Apply runtime override
    proxy.setOverrides([{ tool: 'search', description: 'DYNAMIC override' }]);
    tools = await proxy.listTools();
    expect(tools[0].description).toBe('DYNAMIC override');
  });

  it('clears overrides when called with empty array', async () => {
    const proxy = new McpProxy(makeMockClient(), {
      overrides: [{ tool: 'search', description: 'was overridden' }],
    });

    proxy.setOverrides([]);
    const tools = await proxy.listTools();
    expect(tools[0].description).toBe('Search for items');
  });

  it('getOverrides returns the current set', () => {
    const overrides = [{ tool: 'search', description: 'x' }];
    const proxy = new McpProxy(makeMockClient(), { overrides });
    expect(proxy.getOverrides()).toEqual(overrides);
  });
});

// ---------------------------------------------------------------------------
// getClient()
// ---------------------------------------------------------------------------

describe('McpProxy — getClient()', () => {
  it('returns the underlying client', () => {
    const client = makeMockClient();
    const proxy = new McpProxy(client);
    expect(proxy.getClient()).toBe(client);
  });
});

// ---------------------------------------------------------------------------
// applyOverridesToIntrospection (standalone helper)
// ---------------------------------------------------------------------------

describe('applyOverridesToIntrospection', () => {
  const base: ServerIntrospection = {
    server: { name: 'srv', version: '1', transport: 'stdio' },
    tools: [
      {
        name: 'tool1',
        description: 'original',
        inputSchema: { type: 'object', properties: {} },
        findings: [],
      },
      {
        name: 'tool2',
        description: 'stays put',
        inputSchema: { type: 'object', properties: {} },
        findings: [],
      },
    ],
    resources: [],
    prompts: [],
  };

  it('applies override to a matching tool', () => {
    const result = applyOverridesToIntrospection(base, [
      { tool: 'tool1', description: 'overridden' },
    ]);
    expect(result.tools[0].description).toBe('overridden');
  });

  it('does not affect non-matching tools', () => {
    const result = applyOverridesToIntrospection(base, [
      { tool: 'tool1', description: 'overridden' },
    ]);
    expect(result.tools[1].description).toBe('stays put');
  });

  it('returns the original object unchanged when overrides is empty', () => {
    const result = applyOverridesToIntrospection(base, []);
    expect(result).toBe(base); // same reference — no copy needed
  });

  it('does NOT mutate the original introspection', () => {
    applyOverridesToIntrospection(base, [
      { tool: 'tool1', description: 'mutated?' },
    ]);
    expect(base.tools[0].description).toBe('original');
  });

  it('preserves server metadata, resources, and prompts unchanged', () => {
    const result = applyOverridesToIntrospection(base, [
      { tool: 'tool1', description: 'x' },
    ]);
    expect(result.server).toBe(base.server);
    expect(result.resources).toBe(base.resources);
    expect(result.prompts).toBe(base.prompts);
  });
});
