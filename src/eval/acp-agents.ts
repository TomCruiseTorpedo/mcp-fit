/**
 * Pinned ACP agent registry (ADR-G6).
 *
 * Registry entries are DATA, not code — adding an agent to the eval fleet is
 * a config addition. Each entry describes how to spawn the agent as an ACP
 * subprocess (JSON-RPC over stdio).
 *
 * Auth expectations are the operator's responsibility: e.g. Gemini needs
 * GEMINI_API_KEY in the environment for headless use (its interactive login
 * hangs without a TTY), and claude-agent-acp inherits the local Claude
 * credentials.
 *
 * ADR: ADR-G (docs/adr/ADR-G-acp-harness.md)
 */

/** How to spawn one ACP agent as a subprocess. */
export interface AcpAgentSpec {
  /** Stable registry id, e.g. 'claude-agent-acp'. */
  id: string;
  /** Executable (resolved via PATH). */
  command: string;
  /** Command-line arguments. */
  args: string[];
  /** Extra environment variables (merged over the inherited environment). */
  env?: Record<string, string>;
}

/**
 * v1 reference agents (ADR-G6). Version pins are deliberate — bump them
 * consciously, not transitively.
 */
export const ACP_AGENTS: Readonly<Record<string, AcpAgentSpec>> = Object.freeze({
  'claude-agent-acp': {
    id: 'claude-agent-acp',
    command: 'npx',
    args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.55'],
  },
  gemini: {
    id: 'gemini',
    command: 'gemini',
    args: ['--experimental-acp'],
  },
});
