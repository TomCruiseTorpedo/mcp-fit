/**
 * Introspection — enumerate tools, resources, and prompts from a connected
 * MCP client, normalising the SDK response into the project's shared types.
 *
 * Capabilities declared by the server gate which lists are attempted; if a
 * capability is absent, the corresponding slice is returned as an empty array.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  McpInputSchema,
  ServerIntrospection,
  ServerMeta,
  ToolDef,
  ResourceDef,
  PromptDef,
} from '../types.js';
import { McpConnectError } from './client.js';
import type { TransportKind } from './transports.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enumerate tools, resources, and prompts from a connected MCP client.
 *
 * @param client      A successfully connected `Client` instance.
 * @param transportKind  The transport used to connect (for error messages).
 * @returns           A normalised `ServerIntrospection` value.
 * @throws {McpConnectError}  On introspection-time protocol errors.
 */
export async function introspect(
  client: Client,
  transportKind: TransportKind
): Promise<ServerIntrospection> {
  // Server info must be present after a successful connect/initialize exchange.
  const info = client.getServerVersion();
  if (!info) {
    throw new McpConnectError(
      transportKind,
      'server-info',
      'no implementation info after handshake'
    );
  }

  const server: ServerMeta = {
    name: info.name,
    version: info.version,
    transport: transportKind,
  };

  const caps = client.getServerCapabilities() ?? {};

  let tools: ToolDef[] = [];
  let resources: ResourceDef[] = [];
  let prompts: PromptDef[] = [];

  try {
    if (caps.tools !== undefined) {
      const result = await client.listTools();
      tools = result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as unknown as McpInputSchema,
        findings: [],
      }));
    }

    if (caps.resources !== undefined) {
      const result = await client.listResources();
      resources = result.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    }

    if (caps.prompts !== undefined) {
      const result = await client.listPrompts();
      prompts = result.prompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));
    }
  } catch (err) {
    if (err instanceof McpConnectError) throw err;
    throw new McpConnectError(transportKind, 'list-capabilities', err);
  }

  return { server, tools, resources, prompts };
}
