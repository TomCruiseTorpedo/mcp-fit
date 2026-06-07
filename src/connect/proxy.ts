/**
 * Re-presentation proxy — overrides tool and parameter descriptions without
 * altering server behaviour.
 *
 * Design rationale (ADR-D): third-party servers cannot have their source
 * edited, so mcp-fit proxies them with rewritten descriptions. The proxy:
 *   - Applies `DescriptionOverride` records to `listTools()` output.
 *   - Forwards `callTool()` to the underlying client unchanged (behaviour
 *     is transparent; only the description layer is touched).
 *   - Supports runtime override updates (`setOverrides`), enabling the
 *     fix-mode before/after without reconnecting.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  DescriptionOverride,
  McpInputSchema,
  ToolDef,
  ServerIntrospection,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a single override record to a `ToolDef`.
 *
 * Returns a new object (no mutation of the original).
 */
function applyOverride(tool: ToolDef, override: DescriptionOverride): ToolDef {
  const result: ToolDef = { ...tool };

  if (override.description !== undefined) {
    result.description = override.description;
  }

  if (override.params !== undefined && result.inputSchema) {
    const schema = structuredClone(result.inputSchema) as {
      properties?: Record<string, Record<string, unknown>>;
    };

    for (const [paramName, newDesc] of Object.entries(override.params)) {
      if (schema.properties?.[paramName] !== undefined) {
        schema.properties[paramName] = {
          ...schema.properties[paramName],
          description: newDesc,
        };
      }
    }

    result.inputSchema = schema as unknown as McpInputSchema;
  }

  return result;
}

// ---------------------------------------------------------------------------
// McpProxy
// ---------------------------------------------------------------------------

export interface ProxyOptions {
  /** Initial set of description overrides to apply */
  overrides?: DescriptionOverride[];
}

/**
 * In-process proxy wrapping a connected `Client`.
 *
 * - `listTools()`: returns tool definitions with overrides applied.
 * - `callTool()`: forwards directly to the underlying client (unchanged behaviour).
 * - `setOverrides()`: replaces the active override set at runtime.
 */
export class McpProxy {
  private overrideMap: Map<string, DescriptionOverride>;

  constructor(
    private readonly client: Client,
    options: ProxyOptions = {}
  ) {
    this.overrideMap = buildOverrideMap(options.overrides ?? []);
  }

  // -------------------------------------------------------------------------
  // Introspection (with overrides)
  // -------------------------------------------------------------------------

  /**
   * List tools from the underlying server, with description overrides applied.
   */
  async listTools(): Promise<ToolDef[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => {
      const tool: ToolDef = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as unknown as McpInputSchema,
        findings: [],
      };
      const override = this.overrideMap.get(t.name);
      return override ? applyOverride(tool, override) : tool;
    });
  }

  // -------------------------------------------------------------------------
  // Tool invocation (transparent passthrough)
  // -------------------------------------------------------------------------

  /**
   * Invoke a tool on the underlying server.
   *
   * Arguments are forwarded unmodified; the result is returned unmodified.
   * Overrides have no effect on invocation — only descriptions change.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return this.client.callTool({ name, arguments: args });
  }

  // -------------------------------------------------------------------------
  // Runtime override management
  // -------------------------------------------------------------------------

  /**
   * Replace the active override set.
   *
   * Subsequent `listTools()` calls will use the new overrides.
   */
  setOverrides(overrides: DescriptionOverride[]): void {
    this.overrideMap = buildOverrideMap(overrides);
  }

  /**
   * Return the current override set (for inspection / diffing).
   */
  getOverrides(): DescriptionOverride[] {
    return Array.from(this.overrideMap.values());
  }

  /**
   * Access the underlying `Client` (for introspection of resources/prompts,
   * or direct call patterns that bypass the proxy layer).
   */
  getClient(): Client {
    return this.client;
  }
}

// ---------------------------------------------------------------------------
// Standalone helper (used by fix-mode / batch operations)
// ---------------------------------------------------------------------------

/**
 * Apply a set of description overrides to a full `ServerIntrospection` value.
 *
 * Returns a new object; the original is not mutated.
 */
export function applyOverridesToIntrospection(
  introspection: ServerIntrospection,
  overrides: DescriptionOverride[]
): ServerIntrospection {
  if (overrides.length === 0) return introspection;

  const map = buildOverrideMap(overrides);
  return {
    ...introspection,
    tools: introspection.tools.map((tool) => {
      const override = map.get(tool.name);
      return override ? applyOverride(tool, override) : tool;
    }),
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildOverrideMap(
  overrides: DescriptionOverride[]
): Map<string, DescriptionOverride> {
  return new Map(overrides.map((o) => [o.tool, o]));
}
