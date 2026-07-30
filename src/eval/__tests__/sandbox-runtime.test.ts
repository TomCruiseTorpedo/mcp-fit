/**
 * Tests for the optional OS sandbox.
 *
 * The importer is injected throughout so these run whether or not SRT is
 * actually installed — it is an OPTIONAL dependency, so "absent" is an
 * ordinary case, not a broken environment.
 *
 * The cases that matter most are the FALLBACKS, because they are what most
 * users hit. A fallback that is silent, or that lets the posture imply
 * containment it does not have, is the failure this module is built to avoid.
 */

import { describe, it, expect } from 'vitest';
import { DENY_READ_PATHS, loadSandbox, sandboxProfile } from '../sandbox-runtime.js';

const HOME = '/tmp/fake-home';

describe('sandboxProfile', () => {
  it('denies reads of credential stores — NOT covered by SRT defaults', () => {
    // Measured: SRT's default restricts writes and network but leaves reads
    // open. `~/.ssh` and `~/.aws` stayed readable inside a default sandbox.
    const fs = sandboxProfile(HOME)['filesystem'] as Record<string, unknown>;
    const denyRead = fs['denyRead'] as string[];
    expect(denyRead).toContain('~/.ssh');
    expect(denyRead).toContain('~/.aws');
    expect(denyRead).toContain('/etc');
  });

  it('permits writes to the disposable HOME, cwd and temp dirs', () => {
    // /tmp is not optional: a first attempt confined writes to the disposable
    // HOME alone and real toolchains could not start. The security value here
    // is denyRead — credentials are READ — not write confinement.
    const fs = sandboxProfile(HOME)['filesystem'] as Record<string, unknown>;
    const allowWrite = fs['allowWrite'] as string[];
    expect(allowWrite).toContain(HOME);
    expect(allowWrite).toContain('/tmp');
  });

  it('allows no network by default', () => {
    const net = sandboxProfile(HOME)['network'] as Record<string, unknown>;
    expect(net['allowedDomains']).toEqual([]);
    expect(net['allowLocalBinding']).toBe(false);
  });

  it('keeps the deny list short and auditable rather than an allowlist', () => {
    // Deny-then-allow is what makes this tractable. An attempt to enumerate
    // everything a legitimate server may read would be unbounded and would
    // make the scanner report failures that are not failures.
    expect(DENY_READ_PATHS.length).toBeLessThan(15);
  });
});

describe('loadSandbox — fallbacks are reported, never silent', () => {
  it('treats a missing package as an ordinary outcome with an explanation', async () => {
    const result = await loadSandbox(HOME, () => Promise.reject(new Error('MODULE_NOT_FOUND')));
    expect(result.handle).toBeNull();
    expect(result.unavailable).toBe('not-installed');
    expect(result.detail).toMatch(/optional dependency/i);
  });

  it('reports an unsupported platform distinctly from a missing package', async () => {
    const result = await loadSandbox(HOME, () =>
      Promise.resolve({ SandboxManager: { isSupportedPlatform: () => false } }),
    );
    expect(result.unavailable).toBe('unsupported-platform');
  });

  it('reports a failed init distinctly, naming the likely Linux cause', async () => {
    const result = await loadSandbox(HOME, () =>
      Promise.resolve({
        SandboxManager: {
          isSupportedPlatform: () => true,
          initialize: () => Promise.reject(new Error('bwrap not found')),
        },
      }),
    );
    expect(result.unavailable).toBe('init-failed');
    expect(result.detail).toMatch(/bubblewrap or socat/i);
    // A sandbox that failed to start must not look like one never asked for.
    expect(result.detail).not.toMatch(/optional dependency/i);
  });

  it('always explains itself when there is no handle', async () => {
    for (const importer of [
      () => Promise.reject(new Error('nope')),
      () => Promise.resolve({}),
      () => Promise.resolve({ SandboxManager: { isSupportedPlatform: () => false } }),
    ]) {
      const result = await loadSandbox(HOME, importer);
      expect(result.handle).toBeNull();
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('loadSandbox — success path', () => {
  const workingManager = (capture: { argv?: string[]; cfg?: unknown }) => ({
    SandboxManager: {
      isSupportedPlatform: () => true,
      initialize: (cfg: unknown) => {
        capture.cfg = cfg;
        return Promise.resolve();
      },
      wrapWithSandboxArgv: (command: string) => {
        capture.argv = [command];
        return Promise.resolve({ argv: ['srt', '--', command], env: { SANDBOXED: '1' } });
      },
    },
  });

  it('returns a handle that wraps a command into argv/env', async () => {
    const capture: { argv?: string[]; cfg?: unknown } = {};
    const result = await loadSandbox(HOME, () => Promise.resolve(workingManager(capture)));
    expect(result.handle).not.toBeNull();

    const wrapped = await result.handle!.wrap('node', ['server.js'], HOME);
    expect(wrapped?.argv[0]).toBe('srt');
    expect(wrapped?.env['SANDBOXED']).toBe('1');
  });

  it('passes the deny-read profile to initialize', async () => {
    const capture: { argv?: string[]; cfg?: unknown } = {};
    await loadSandbox(HOME, () => Promise.resolve(workingManager(capture)));
    const fs = (capture.cfg as Record<string, unknown>)['filesystem'] as Record<string, unknown>;
    expect(fs['denyRead']).toContain('~/.ssh');
  });

  it('quotes arguments containing spaces when building the command string', async () => {
    const capture: { argv?: string[]; cfg?: unknown } = {};
    const result = await loadSandbox(HOME, () => Promise.resolve(workingManager(capture)));
    await result.handle!.wrap('node', ['my server.js'], HOME);
    expect(capture.argv?.[0]).toContain('"my server.js"');
  });

  it('returns null from wrap() rather than throwing when wrapping fails', async () => {
    const result = await loadSandbox(HOME, () =>
      Promise.resolve({
        SandboxManager: {
          isSupportedPlatform: () => true,
          initialize: () => Promise.resolve(),
          wrapWithSandboxArgv: () => Promise.reject(new Error('boom')),
        },
      }),
    );
    await expect(result.handle!.wrap('node', [], HOME)).resolves.toBeNull();
  });

  it('describes the mechanism WITHOUT asserting containment', async () => {
    // The mechanism string feeds the posture, but a failed self-test still
    // forces `none`. Loading the sandbox is never itself evidence.
    const capture: { argv?: string[]; cfg?: unknown } = {};
    const result = await loadSandbox(HOME, () => Promise.resolve(workingManager(capture)));
    expect(result.handle!.mechanism).toMatch(/sandbox-runtime/);
    expect(result.detail).toMatch(/verified independently/i);
  });
});
