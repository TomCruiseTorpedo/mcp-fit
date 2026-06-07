/**
 * Transport factory — creates typed MCP client transports.
 *
 * Supports stdio (spawn-a-process) and SSE (legacy remote). The
 * StreamableHTTP transport (recommended for new remote servers) can be
 * added in a future bead; SSE covers all currently public MCP servers.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

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
      });

    case 'sse':
      return new SSEClientTransport(new URL(opts.url), {
        requestInit: opts.headers
          ? { headers: opts.headers as Record<string, string> }
          : undefined,
      });
  }
}
