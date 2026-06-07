/**
 * MCP client factory with actionable error handling.
 *
 * Wraps the SDK's Client.connect() so that handshake failures emit a
 * human-readable message naming the transport and the failed step — no
 * raw stack dumps exposed to end-users.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportKind } from './transports.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Emitted when the MCP client cannot establish or complete a connection.
 *
 * The message is intentionally user-facing: "transport kind + failed step +
 * cause message". No stack trace of the underlying SDK error is included.
 */
export class McpConnectError extends Error {
  constructor(
    public readonly transport: TransportKind,
    public readonly step: string,
    cause: unknown
  ) {
    const causeMsg =
      cause instanceof Error ? cause.message : String(cause);
    super(`[mcp-fit] ${transport} connection failed at ${step}: ${causeMsg}`);
    this.name = 'McpConnectError';
    // Suppress the cause chain so no raw SDK internals leak to callers
    // (callers that want the cause can access this.transport + this.step).
  }
}

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  /** Client name advertised to the server (default: "mcp-fit") */
  name?: string;
  /** Client version advertised to the server (default: "0.1.0") */
  version?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and connect an MCP client via the supplied transport.
 *
 * @throws {McpConnectError} on any connection or handshake failure.
 */
export async function connectClient(
  transport: Transport,
  transportKind: TransportKind,
  options: ConnectOptions = {}
): Promise<Client> {
  const client = new Client(
    {
      name: options.name ?? 'mcp-fit',
      version: options.version ?? '0.1.0',
    },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch (err) {
    throw new McpConnectError(transportKind, 'handshake', err);
  }

  return client;
}
