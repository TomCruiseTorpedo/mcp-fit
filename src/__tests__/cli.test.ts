/**
 * CLI entry — `--version` / `-v`, and the dispatch around them.
 *
 * cli.ts runs main() at import time against process.argv, so each case sets
 * argv, spies on stdout / stderr / process.exit, and imports a fresh copy of
 * the module. The expected version is read from package.json here, not from
 * cli.ts, so the assertion fails if the printed value ever stops following
 * the package.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PKG_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

interface CliRun {
  stdout: string;
  stderr: string;
  exitCodes: Array<number | undefined>;
  exitCode: typeof process.exitCode;
}

const realArgv = process.argv;
const realExitCode = process.exitCode;

async function runCli(...args: string[]): Promise<CliRun> {
  process.argv = ['node', 'mcp-fit', ...args];
  process.exitCode = undefined;
  let stdout = '';
  let stderr = '';
  const exitCodes: Array<number | undefined> = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  // Record instead of exiting; the parser carries on past a recorded exit,
  // which is fine because only the first recorded code is asserted on.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code);
  }) as typeof process.exit);

  vi.resetModules();
  await import('../cli.js'); // main() starts here
  await new Promise((resolve) => setImmediate(resolve)); // let it settle

  return { stdout, stderr, exitCodes, exitCode: process.exitCode };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = realArgv;
  process.exitCode = realExitCode;
});

describe('cli --version', () => {
  it('reads a real semver from package.json (guards the assertions below)', () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(['--version', '-v'])('%s prints exactly package.json version and exits 0', async (flag) => {
    const run = await runCli(flag);
    expect(run.stdout).toBe(`${PKG_VERSION}\n`);
    expect(run.stderr).toBe('');
    expect(run.exitCodes).toEqual([]); // never called process.exit(non-zero)
    expect(run.exitCode ?? 0).toBe(0);
  });
});

describe('cli dispatch around --version', () => {
  it('help banner still carries the version and is not replaced by the bare number', async () => {
    const run = await runCli('help');
    expect(run.stdout).toContain(`mcp-fit v${PKG_VERSION} — Score and fix MCP server agent-usability.`);
    expect(run.stdout).not.toBe(`${PKG_VERSION}\n`);
    expect(run.exitCodes).toEqual([]);
  });

  it('lists the flag in the help text', async () => {
    const run = await runCli('help');
    expect(run.stdout).toContain('mcp-fit --version');
  });

  it.each(['--help', '-h'])('%s still prints the help banner', async (flag) => {
    const run = await runCli(flag);
    expect(run.stdout).toContain(`mcp-fit v${PKG_VERSION}`);
    expect(run.exitCodes).toEqual([]);
  });

  it('an unknown subcommand is still rejected with exit 1', async () => {
    const run = await runCli('--versionx');
    expect(run.stderr).toContain("unknown subcommand '--versionx'");
    expect(run.exitCodes[0]).toBe(1);
  });
});
