/**
 * Unit tests for src/eval/sandbox.ts — B-005 acceptance criteria:
 *
 *  1. Sandbox filters tool list to allowedToolNames
 *  2. Sandbox denies host filesystem/shell tools (SandboxError thrown)
 *  3. Sandbox denies tools not in the allowed set (SandboxError thrown)
 *  4. Sandbox passes through allowed tool calls
 *  5. Scratch space get/set/has/delete works
 *  6. isDeniedHostCapability flags the canonical patterns
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Sandbox,
  SandboxError,
  createSandbox,
  isDeniedHostCapability,
} from '../sandbox.js';
import type { Toolset } from '../sandbox.js';
import type { ToolDef } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolDef(name: string): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' },
    findings: [],
  };
}

function makeMockToolset(toolNames: string[]): Toolset {
  return {
    listTools: vi
      .fn()
      .mockResolvedValue(toolNames.map((n) => makeToolDef(n))),
    callTool: vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ result: `called ${name}` }),
      ),
  };
}

// ---------------------------------------------------------------------------
// Tool list filtering
// ---------------------------------------------------------------------------

describe('Sandbox — tool list filtering', () => {
  it('only exposes tools in the allowed set', async () => {
    const toolset = makeMockToolset(['search', 'get', 'create']);
    const sandbox = createSandbox(toolset, new Set(['search', 'get']));

    const tools = await sandbox.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('get');
    expect(names).not.toContain('create');
  });

  it('returns empty list when allowed set is empty', async () => {
    const toolset = makeMockToolset(['search', 'get']);
    const sandbox = createSandbox(toolset, new Set());

    const tools = await sandbox.listTools();
    expect(tools).toHaveLength(0);
  });

  it('excludes host-capability tools even if they are in the allowed set', async () => {
    const toolset = makeMockToolset(['search', 'read_file', 'bash']);
    // Mistakenly allow read_file and bash — sandbox must still exclude them
    const sandbox = createSandbox(toolset, new Set(['search', 'read_file', 'bash']));

    const tools = await sandbox.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('search');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('bash');
  });
});

// ---------------------------------------------------------------------------
// Tool call enforcement — host filesystem / shell denial
// ---------------------------------------------------------------------------

describe('Sandbox — host capability denial (security)', () => {
  it('throws SandboxError when calling read_file', async () => {
    const toolset = makeMockToolset(['read_file', 'search']);
    const sandbox = createSandbox(toolset, new Set(['read_file', 'search']));

    await expect(
      sandbox.callTool('read_file', { path: '/etc/passwd' }),
    ).rejects.toThrow(SandboxError);
  });

  it('throws SandboxError when calling write_file', async () => {
    const toolset = makeMockToolset(['write_file']);
    const sandbox = createSandbox(toolset, new Set(['write_file']));

    await expect(
      sandbox.callTool('write_file', { path: '/tmp/x', content: 'evil' }),
    ).rejects.toThrow(SandboxError);
  });

  it('throws SandboxError when calling bash', async () => {
    const toolset = makeMockToolset(['bash']);
    const sandbox = createSandbox(toolset, new Set(['bash']));

    await expect(
      sandbox.callTool('bash', { command: 'rm -rf /' }),
    ).rejects.toThrow(SandboxError);
  });

  it('throws SandboxError when calling shell', async () => {
    const toolset = makeMockToolset(['shell']);
    const sandbox = createSandbox(toolset, new Set(['shell']));

    await expect(
      sandbox.callTool('shell', { cmd: 'cat /etc/shadow' }),
    ).rejects.toThrow(SandboxError);
  });

  it('throws SandboxError when calling execute', async () => {
    const toolset = makeMockToolset(['execute']);
    const sandbox = createSandbox(toolset, new Set(['execute']));

    await expect(
      sandbox.callTool('execute', { program: '/bin/sh' }),
    ).rejects.toThrow(SandboxError);
  });

  it('SandboxError message names the denied tool', async () => {
    const toolset = makeMockToolset(['bash']);
    const sandbox = createSandbox(toolset, new Set(['bash']));

    const err = await sandbox.callTool('bash', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).message).toContain("'bash'");
  });
});

// ---------------------------------------------------------------------------
// Tool call enforcement — allowed-set denial
// ---------------------------------------------------------------------------

describe('Sandbox — allowed-set enforcement', () => {
  it('throws SandboxError for a tool not in the allowed set', async () => {
    const toolset = makeMockToolset(['search', 'admin']);
    const sandbox = createSandbox(toolset, new Set(['search']));

    await expect(
      sandbox.callTool('admin', {}),
    ).rejects.toThrow(SandboxError);
  });

  it('passes through calls for allowed tools', async () => {
    const toolset = makeMockToolset(['search']);
    const sandbox = createSandbox(toolset, new Set(['search']));

    const result = await sandbox.callTool('search', { q: 'hello' });
    expect(result).toEqual({ result: 'called search' });
  });
});

// ---------------------------------------------------------------------------
// Scratch space
// ---------------------------------------------------------------------------

describe('Sandbox — scratch space', () => {
  it('set and get work', () => {
    const sandbox = new Sandbox(makeMockToolset([]), new Set());
    sandbox.scratchSet('key', 'value');
    expect(sandbox.scratchGet('key')).toBe('value');
  });

  it('delete removes the key', () => {
    const sandbox = new Sandbox(makeMockToolset([]), new Set());
    sandbox.scratchSet('k', 42);
    sandbox.scratchDelete('k');
    expect(sandbox.scratchHas('k')).toBe(false);
    expect(sandbox.scratchGet('k')).toBeUndefined();
  });

  it('has returns false for missing keys', () => {
    const sandbox = new Sandbox(makeMockToolset([]), new Set());
    expect(sandbox.scratchHas('missing')).toBe(false);
  });

  it('each sandbox instance has isolated scratch', () => {
    const toolset = makeMockToolset([]);
    const a = new Sandbox(toolset, new Set());
    const b = new Sandbox(toolset, new Set());
    a.scratchSet('shared', 'from-a');
    expect(b.scratchHas('shared')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDeniedHostCapability helper
// ---------------------------------------------------------------------------

describe('isDeniedHostCapability', () => {
  const denied = [
    'read_file', 'write_file', 'list_directory', 'list_dir',
    'execute', 'shell', 'bash', 'run_command', 'exec', 'system',
    'fs_read', 'fs_write', 'net_fetch', 'network_get',
    'http_request', 'curl', 'wget',
  ];

  const allowed = ['search', 'get_note', 'create_note', 'process', 'find', 'change', 'remove'];

  for (const name of denied) {
    it(`denies '${name}'`, () => {
      expect(isDeniedHostCapability(name)).toBe(true);
    });
  }

  for (const name of allowed) {
    it(`allows '${name}'`, () => {
      expect(isDeniedHostCapability(name)).toBe(false);
    });
  }
});
