/**
 * Pinned ACP agent registry (ADR-G6).
 *
 * Registry entries are DATA, not code — adding an agent to the eval fleet is
 * a config addition. Each entry describes how to spawn the agent as an ACP
 * subprocess (JSON-RPC over stdio).
 *
 * Each entry declares the credentials it needs (`auth`). Under the default
 * `clean` isolation (ADR-G8) that declaration is all the agent receives from
 * the operator; under `inherit` it gets the operator's whole environment and
 * HOME, as before.
 *
 * ADR: ADR-G (docs/adr/ADR-G-acp-harness.md)
 */

/**
 * What an agent needs to authenticate when it runs with a clean home
 * (ADR-G8). Under `clean` isolation nothing else from the operator's
 * environment or HOME reaches the agent, so this declaration is the whole of
 * its credentials.
 */
export interface AcpAgentAuth {
  /**
   * Environment variable NAMES passed through from the operator's
   * environment. Only names are declared here; values are never logged.
   */
  env?: string[];
  /**
   * Paths relative to the operator's HOME, copied into the clean home with
   * mode 0600 (for an agent that keeps its token in a file). Absolute paths
   * and `..` segments are refused.
   */
  homeFiles?: string[];
  /**
   * When true, a `clean` run fails before spawning unless at least one `env`
   * variable is set or one `homeFiles` entry exists. A logged-out agent would
   * otherwise make no tool calls and surface as a misleading no-contact trace.
   */
  required?: boolean;
}

/** How to spawn one ACP agent as a subprocess. */
export interface AcpAgentSpec {
  /** Stable registry id, e.g. 'claude-agent-acp'. */
  id: string;
  /** Executable (resolved via PATH). */
  command: string;
  /** Command-line arguments. */
  args: string[];
  /**
   * Extra environment variables, applied last. Under `clean` isolation they
   * join the allowlisted environment; under `inherit` they are merged over
   * the operator's full environment.
   */
  env?: Record<string, string>;
  /** Credentials the agent needs under `clean` isolation (ADR-G8). */
  auth?: AcpAgentAuth;
}

/**
 * v1 reference agents (ADR-G6). Version pins are deliberate — bump them
 * consciously, not transitively.
 *
 * Auth under `clean` isolation (ADR-G8):
 * - claude-agent-acp: on macOS the Claude login lives in the Keychain, not in
 *   a file, and a clean HOME leaves `claude` reporting "Not logged in"
 *   (measured 2026-10-14). Supply CLAUDE_CODE_OAUTH_TOKEN (from
 *   `claude setup-token`) or ANTHROPIC_API_KEY. Whether claude-agent-acp
 *   accepts the OAuth token end to end has not been verified yet.
 * - gemini: GEMINI_API_KEY, as before (the interactive login hangs headless).
 */
export const ACP_AGENTS: Readonly<Record<string, AcpAgentSpec>> = Object.freeze({
  'claude-agent-acp': {
    id: 'claude-agent-acp',
    command: 'npx',
    args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.55'],
    auth: { env: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], required: true },
  },
  gemini: {
    id: 'gemini',
    command: 'gemini',
    args: ['--experimental-acp'],
    auth: { env: ['GEMINI_API_KEY'], required: true },
  },
});
