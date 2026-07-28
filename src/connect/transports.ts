/**
 * Transport factory — creates typed MCP client transports.
 *
 * Supports stdio (spawn-a-process) and SSE (legacy remote). The
 * StreamableHTTP transport (recommended for new remote servers) can be
 * added in a future bead; SSE covers all currently public MCP servers.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ---------------------------------------------------------------------------
// Disposable workspace
// ---------------------------------------------------------------------------

/** A throwaway HOME for one spawned server, removed on `dispose()`. */
export interface DisposableWorkspace {
  /** Fresh directory handed to the spawned server as `HOME`. */
  home: string;
  /**
   * A fresh empty directory, available for probes that want somewhere
   * disposable to start.
   *
   * NOT used as the spawned server's cwd — see the note on
   * `createDisposableWorkspace` for why that was tried and reverted.
   */
  cwd: string;
  /** Remove the workspace. Safe to call more than once. */
  dispose(): void;
}

/**
 * Create a throwaway HOME and cwd for a spawned server.
 *
 * WHAT THIS ACTUALLY BUYS, stated precisely because the surrounding claims
 * have been wrong before.
 *
 * The MCP SDK already restricts the spawned process's environment to an
 * allowlist — measured, not assumed: HOME, LOGNAME, PATH, SHELL, TERM, USER.
 * `AWS_ACCESS_KEY_ID`, `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are NOT passed.
 * So environment exfiltration is largely closed already and is not what this
 * addresses.
 *
 * The remaining vector is the FILESYSTEM: `HOME` *is* on that allowlist, and
 * the process runs as the invoking user, so `~/.aws/credentials`, `~/.ssh` and
 * `~/.npmrc` are readable by anything that resolves a HOME-relative path.
 * Pointing HOME at an empty temp directory cuts that class.
 *
 * WHAT IT DOES NOT BUY, and must never be described as buying: ABSOLUTE paths
 * still resolve. A server that opens `/Users/<you>/.ssh/id_rsa` directly is
 * completely unaffected, as is one that reads `/etc/passwd`, opens a socket,
 * or spawns a child. The process still runs as this user with full network
 * access. Real containment needs an OS-level sandbox; this raises the floor
 * cheaply and cross-platform, and the isolation posture it produces is
 * `process`, never `namespace`.
 *
 * WHY THE CWD IS NOT REPLACED, THOUGH `cwd` EXISTS HERE. Pointing the spawned
 * server at a disposable cwd was implemented and reverted: the operator names
 * the server with paths relative to their OWN directory, and not only for the
 * executable. mcp-fit's own documented demo passes a relative SCRIPT PATH as an
 * argument (`… /.bin/tsx fixtures/strawman-server/server.ts`), which the child
 * resolves against its cwd. Resolving the command is easy; arguments cannot be
 * rewritten safely, because there is no way to tell a path argument from any
 * other string. So a disposable cwd broke the tool's own README command in
 * exchange for a much smaller win than HOME — the secrets worth protecting
 * (`~/.aws`, `~/.ssh`, `~/.npmrc`) are all HOME-relative. Do not add it back
 * without solving the relative-argument problem first.
 */
export function createDisposableWorkspace(): DisposableWorkspace {
  const base = mkdtempSync(join(tmpdir(), 'mcp-fit-sandbox-'));
  const home = join(base, 'home');
  const cwd = join(base, 'cwd');
  mkdirSync(home);
  mkdirSync(cwd);

  let disposed = false;
  return {
    home,
    cwd,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Transport config discriminated union
// ---------------------------------------------------------------------------

export interface StdioTransportOptions {
  kind: 'stdio';
  /** Executable to spawn */
  command: string;
  /** Arguments passed to the executable */
  args?: string[];
  /**
   * Environment variables for the spawned process.
   * Defaults to a safe subset of the current environment (MCP SDK default).
   */
  env?: Record<string, string>;
  /**
   * Working directory for the spawned process. Pass a
   * `DisposableWorkspace.cwd` so the server does not start in the operator's
   * directory.
   */
  cwd?: string;
}

export interface SseTransportOptions {
  kind: 'sse';
  /** Full URL of the SSE endpoint (e.g. http://localhost:3001/sse) */
  url: string;
  /** Additional HTTP headers sent on the initial SSE request */
  headers?: Record<string, string>;
}

export type TransportOptions = StdioTransportOptions | SseTransportOptions;
export type TransportKind = TransportOptions['kind'];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP transport from configuration options.
 *
 * Returns an unstarted transport; caller connects it via `Client.connect()`.
 */
export function createTransport(
  opts: TransportOptions
): StdioClientTransport | SSEClientTransport {
  switch (opts.kind) {
    case 'stdio':
      return new StdioClientTransport({
        command: opts.command,
        args: opts.args ?? [],
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });

    case 'sse':
      return new SSEClientTransport(new URL(opts.url), {
        requestInit: opts.headers
          ? { headers: opts.headers as Record<string, string> }
          : undefined,
      });
  }
}
