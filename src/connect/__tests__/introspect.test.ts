/**
 * Unit tests for src/connect/introspect.ts
 *
 * Scenarios covered (from spec):
 *   - stdio introspection: retrieves full tools/list with schemas
 *   - SSE transport kind recorded in server metadata
 *   - Capabilities gate: no tools capability → empty tools array
 *   - Unreachable / no server-info → McpConnectError (actionable message)
 */

import { describe, it, expect } from 'vitest';
import { introspect } from '../introspect.js';
import { McpConnectError } from '../client.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type MockOverrides = {
  getServerVersion?: () => { name: string; version: string } | undefined;
  getServerCapabilities?: () => Record<string, unknown> | undefined;
  listTools?: () => Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;
  listResources?: () => Promise<{ resources: Array<{ uri: string; name: string }> }>;
  listPrompts?: () => Promise<{
    prompts: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>;
  }>;
};

function makeMockClient(overrides: MockOverrides = {}): Client {
  return {
    getServerVersion: () => ({ name: 'test-server', version: '1.2.3' }),
    getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
    listTools: async () => ({
      tools: [
        {
          name: 'my_tool',
          description: 'A useful tool',
          inputSchema: {
            type: 'object',
            properties: { x: { type: 'string', description: 'input x' } },
            required: ['x'],
          },
        },
      ],
    }),
    listResources: async () => ({
      resources: [{ uri: 'file:///data', name: 'data' }],
    }),
    listPrompts: async () => ({
      prompts: [
        {
          name: 'my_prompt',
          description: 'A prompt',
          arguments: [{ name: 'topic', description: 'The topic', required: true }],
        },
      ],
    }),
    ...overrides,
  } as unknown as Client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('introspect', () => {
  it('returns server metadata with correct name, version, and transport', async () => {
    const client = makeMockClient();
    const result = await introspect(client, 'stdio');

    expect(result.server).toEqual({
      name: 'test-server',
      version: '1.2.3',
      transport: 'stdio',
    });
  });

  it('records SSE transport kind in server metadata', async () => {
    const client = makeMockClient();
    const result = await introspect(client, 'sse');
    expect(result.server.transport).toBe('sse');
  });

  it('returns tools with name, description, inputSchema, and empty findings', async () => {
    const client = makeMockClient();
    const result = await introspect(client, 'stdio');

    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0];
    expect(tool.name).toBe('my_tool');
    expect(tool.description).toBe('A useful tool');
    expect(tool.inputSchema).toMatchObject({ type: 'object' });
    expect(tool.findings).toEqual([]);
  });

  it('returns resources from the server', async () => {
    const client = makeMockClient();
    const result = await introspect(client, 'stdio');
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe('file:///data');
  });

  it('returns prompts from the server', async () => {
    const client = makeMockClient();
    const result = await introspect(client, 'stdio');
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].name).toBe('my_prompt');
    expect(result.prompts[0].arguments).toHaveLength(1);
    expect(result.prompts[0].arguments?.[0].required).toBe(true);
  });

  it('skips tools list when server declares no tools capability', async () => {
    const client = makeMockClient({
      getServerCapabilities: () => ({}), // no tools
    });
    const result = await introspect(client, 'stdio');
    expect(result.tools).toHaveLength(0);
  });

  it('skips resources list when server declares no resources capability', async () => {
    const client = makeMockClient({
      getServerCapabilities: () => ({ tools: {} }), // no resources
    });
    const result = await introspect(client, 'stdio');
    expect(result.resources).toHaveLength(0);
  });

  it('skips prompts list when server declares no prompts capability', async () => {
    const client = makeMockClient({
      getServerCapabilities: () => ({ tools: {}, resources: {} }), // no prompts
    });
    const result = await introspect(client, 'stdio');
    expect(result.prompts).toHaveLength(0);
  });

  it('throws McpConnectError when server returns no implementation info', async () => {
    const client = makeMockClient({
      getServerVersion: () => undefined,
    });
    await expect(introspect(client, 'stdio')).rejects.toBeInstanceOf(McpConnectError);
  });

  it('McpConnectError message names the transport and step', async () => {
    const client = makeMockClient({
      getServerVersion: () => undefined,
    });
    try {
      await introspect(client, 'stdio');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpConnectError);
      const e = err as McpConnectError;
      expect(e.transport).toBe('stdio');
      expect(e.step).toBe('server-info');
      expect(e.message).toContain('stdio');
    }
  });

  it('wraps listTools protocol errors as McpConnectError', async () => {
    const client = makeMockClient({
      listTools: async () => { throw new Error('protocol error'); },
    });
    await expect(introspect(client, 'stdio')).rejects.toBeInstanceOf(McpConnectError);
  });
});
