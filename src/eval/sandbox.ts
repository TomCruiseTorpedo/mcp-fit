/**
 * Eval sandbox — restricts the agent harness to only target-server tools
 * plus an in-memory scratch space.
 *
 * Security contract (spec §Dynamic Eval, ADR-B):
 *   - The eval agent is granted only the target server's tools plus a
 *     sandboxed scratch space.
 *   - Host capabilities (filesystem, shell, broader network) are explicitly
 *     denied even if they somehow appear in the toolset.
 *
 * This is an in-process sandbox (v1). OS-level isolation is out of scope.
 */

import type { ToolDef } from '../types.js';

// ---------------------------------------------------------------------------
// Toolset interface (matches McpProxy shape — structurally compatible)
// ---------------------------------------------------------------------------

/**
 * A toolset: something that can list tools and call them.
 * McpProxy satisfies this interface structurally.
 */
export interface Toolset {
  listTools(): Promise<ToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Denied capability patterns
// ---------------------------------------------------------------------------

/**
 * Tool names that the sandbox always denies — regardless of the allowed set.
 *
 * These guard against a proxied server inadvertently exposing host capabilities.
 * Patterns are matched case-insensitively against the full tool name.
 */
const DENIED_PATTERNS: RegExp[] = [
  /^read_file$/i,
  /^write_file$/i,
  /^list_directory$/i,
  /^list_dir$/i,
  /^execute$/i,
  /^shell$/i,
  /^bash$/i,
  /^run_command$/i,
  /^exec$/i,
  /^system$/i,
  /^fs_/i,
  /^net_/i,
  /^network_/i,
  /^http_/i,
  /^curl$/i,
  /^wget$/i,
];

/** Returns true when `name` matches a host-capability denial pattern. */
export function isDeniedHostCapability(name: string): boolean {
  return DENIED_PATTERNS.some((p) => p.test(name));
}

// ---------------------------------------------------------------------------
// SandboxError
// ---------------------------------------------------------------------------

/** Thrown when the sandbox blocks a tool call. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * In-process sandbox wrapping a `Toolset`.
 *
 * - `listTools()`: returns only tools in `allowedToolNames` that are not host-capability denials.
 * - `callTool()`: forwards to the underlying toolset after enforcement checks.
 * - Scratch space: ephemeral key-value store for the agent session.
 */
export class Sandbox implements Toolset {
  private readonly scratch = new Map<string, unknown>();

  constructor(
    private readonly toolset: Toolset,
    private readonly allowedToolNames: ReadonlySet<string>,
  ) {}

  // -------------------------------------------------------------------------
  // Toolset implementation
  // -------------------------------------------------------------------------

  /** List tools, filtered to allowed set and minus host-capability denials. */
  async listTools(): Promise<ToolDef[]> {
    const all = await this.toolset.listTools();
    return all.filter(
      (t) => this.allowedToolNames.has(t.name) && !isDeniedHostCapability(t.name),
    );
  }

  /**
   * Call a tool through the sandbox enforcement layer.
   *
   * @throws {SandboxError} if the tool matches a host-capability denial pattern.
   * @throws {SandboxError} if the tool is not in the allowed set.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (isDeniedHostCapability(name)) {
      throw new SandboxError(
        `Sandbox: host capability '${name}' is denied — eval agent has no host access`,
      );
    }
    if (!this.allowedToolNames.has(name)) {
      throw new SandboxError(
        `Sandbox: tool '${name}' is not in the allowed tool set for this eval`,
      );
    }
    return this.toolset.callTool(name, args);
  }

  // -------------------------------------------------------------------------
  // Scratch space
  // -------------------------------------------------------------------------

  /** Store a value in the ephemeral scratch space. */
  scratchSet(key: string, value: unknown): void {
    this.scratch.set(key, value);
  }

  /** Retrieve a value from the ephemeral scratch space. Returns undefined if absent. */
  scratchGet(key: string): unknown {
    return this.scratch.get(key);
  }

  /** Delete a value from the ephemeral scratch space. */
  scratchDelete(key: string): void {
    this.scratch.delete(key);
  }

  /** Check whether a key exists in the scratch space. */
  scratchHas(key: string): boolean {
    return this.scratch.has(key);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a sandbox from a toolset.
 *
 * Pass `null` for `allowedToolNames` to allow all tools from the toolset
 * (minus host-capability denials). Pass an explicit set to further restrict.
 *
 * @example
 * ```ts
 * const tools = await proxy.listTools();
 * const allowed = new Set(tools.map(t => t.name));
 * const sandbox = createSandbox(proxy, allowed);
 * ```
 */
export function createSandbox(
  toolset: Toolset,
  allowedToolNames: Set<string>,
): Sandbox {
  return new Sandbox(toolset, allowedToolNames);
}
