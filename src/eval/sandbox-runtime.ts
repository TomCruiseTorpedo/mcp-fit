/**
 * Optional OS sandbox, via `@anthropic-ai/sandbox-runtime` (SRT).
 *
 * WHY OPTIONAL AND NOT REQUIRED. SRT is the right mechanism — it wraps an
 * arbitrary command with Seatbelt on macOS, bubblewrap on Linux, and a
 * dedicated user plus a Windows Filtering Platform egress fence on Windows —
 * but at the time of writing it is `0.0.x` from an org named
 * `anthropic-experimental`, it raises the Node floor from 18 to 20.11, it
 * needs `bubblewrap` and `socat` from a system package manager on Linux, and
 * it ships prebuilt binaries. Making it mandatory would push all four of those
 * costs onto every mcp-fit user, including the ones who only want a
 * usability score. Making it optional puts each cost on the people who asked
 * for containment.
 *
 * Revisit making it a hard dependency if SRT reaches 1.0 AND leaves the
 * `anthropic-experimental` org — until both hold, a pre-1.0 experimental
 * package should not sit in the critical path of a published security tool.
 *
 * THE RULE THAT MATTERS MOST. Loading SRT is NEVER treated as evidence of
 * containment. The self-test in `./containment-check.js` runs either way and
 * is the only thing that sets the isolation posture. A sandbox that is present
 * but misconfigured, silently degraded (SRT itself warns that Linux sockets go
 * unrestricted when seccomp is unavailable), or simply not doing what its
 * README implies must show up as `none` — and it does, because the posture is
 * measured downstream of this module rather than asserted by it.
 *
 * MEASURED, NOT ASSUMED: SRT's DEFAULT config restricts writes and network but
 * NOT reads. Verified on macOS by running mcp-fit's own probe inside it —
 * `/etc/hosts`, `~/.ssh` and `~/.aws` all remained readable. The profile below
 * therefore sets `denyRead` explicitly; with it, the same probe reports
 * `contained: true`. Do not remove those entries believing the defaults cover
 * them.
 */

/** What mcp-fit uses from SRT. Declared structurally: SRT is not installed at build time. */
interface SandboxManagerLike {
  isSupportedPlatform(): boolean;
  checkDependencies(): { satisfied?: boolean; missing?: unknown } | unknown;
  initialize(config: unknown): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    cwd?: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
}

/** Why the sandbox is not in use. Reported so a fallback is never silent. */
export type SandboxUnavailableReason =
  | 'not-installed'
  | 'unsupported-platform'
  | 'missing-dependencies'
  | 'init-failed';

export interface SandboxHandle {
  /** Wrap a command into a sandboxed argv/env pair, or null if wrapping failed. */
  wrap(
    command: string,
    args: readonly string[],
    home: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv } | null>;
  /** Mechanism name for the isolation posture. */
  mechanism: string;
}

export interface SandboxLoadResult {
  handle: SandboxHandle | null;
  unavailable?: SandboxUnavailableReason;
  /** Operator-facing explanation. Always set when `handle` is null. */
  detail: string;
}

/**
 * The read-deny list.
 *
 * Deny-then-allow, which is why this is a short auditable list rather than an
 * attempt to enumerate everything a legitimate MCP server may touch. Naming
 * the credential stores directly avoids the failure mode where an
 * over-restrictive profile makes the scanner report failures that are not
 * failures — a scanner that cries wolf gets ignored.
 */
export const DENY_READ_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.config/gcloud',
  '~/.kube',
  '~/.npmrc',
  '~/.docker',
  '~/.gnupg',
  '~/.netrc',
  '/etc',
];

/**
 * The temp directory SRT gives the sandboxed child.
 *
 * Derived exactly as SRT does it (`sandbox-utils.js`): it overrides the child's
 * `TMPDIR` to `CLAUDE_CODE_TMPDIR || CLAUDE_TMPDIR || /tmp/claude`. The profile
 * has to name that same directory, because anything the target writes to
 * `os.tmpdir()` lands there — including the unix sockets Node toolchains use
 * for IPC.
 */
export function sandboxTmpDir(): string {
  return process.env['CLAUDE_CODE_TMPDIR'] ?? process.env['CLAUDE_TMPDIR'] ?? '/tmp/claude';
}

/**
 * Settings handed to SRT for a scan. Network is denied outright.
 *
 * TWO THINGS THIS PROFILE GETS RIGHT THAT ARE EASY TO GET WRONG.
 *
 * 1. `denyRead` is REQUIRED. SRT's default restricts writes and network but
 *    NOT reads — measured: `/etc/hosts`, `~/.ssh` and `~/.aws` all stayed
 *    readable inside a default sandbox. With `denyRead` set, mcp-fit's own
 *    probe reports `contained: true`. Do not delete these believing the
 *    defaults cover them.
 *
 * 2. `allowUnixSockets` must name the sandbox temp dir as a BARE DIRECTORY
 *    PATH, not a glob. Node toolchains bind a unix socket for IPC under
 *    `os.tmpdir()`, and SRT rewrites the child's `TMPDIR` (see
 *    `sandboxTmpDir`). Measured, because the failure is opaque — the target
 *    dies with `EPERM` on `listen` before it can be introspected:
 *
 *      allowUnixSockets: []                    EPERM
 *      allowUnixSockets: ['/tmp/**']           EPERM   (glob does not match)
 *      allowUnixSockets: ['/tmp/claude/**']    EPERM   (glob does not match)
 *      allowLocalBinding: true, sockets []     EPERM   (governs TCP, not this)
 *      allowUnixSockets: ['/tmp/claude']       OK      <- bare path
 *      allowAllUnixSockets: true               OK      but opens docker.sock
 *
 *    The bare path is used rather than `allowAllUnixSockets` so that sockets
 *    like `/var/run/docker.sock` stay blocked; opening those would trade a
 *    credential-read risk for a container-escape one.
 */
export function sandboxProfile(home: string): Record<string, unknown> {
  return {
    network: {
      // A scanned server has no legitimate need to reach the internet through
      // us. Anything it does need, it can be granted deliberately later.
      allowedDomains: [],
      deniedDomains: [],
      // Bare directory path — a glob here silently fails to match for bind.
      allowUnixSockets: [sandboxTmpDir()],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [...DENY_READ_PATHS],
      allowRead: [],
      // Writes: disposable HOME, cwd, and the sandbox temp dir. The security
      // value here is denyRead — credentials are READ — not write confinement.
      allowWrite: [home, '.', sandboxTmpDir()],
      denyWrite: [],
    },
  };
}

/**
 * Try to load SRT.
 *
 * Never throws and never installs anything. A missing package is an ordinary,
 * expected outcome — it is an optional dependency — and is reported rather
 * than treated as an error.
 */
export async function loadSandbox(
  home: string,
  importer?: (specifier: string) => Promise<unknown>,
): Promise<SandboxLoadResult> {
  // Indirect specifier so the bundler/type-checker does not require SRT to be
  // present at build time; it genuinely may not be.
  const specifier = '@anthropic-ai/sandbox-runtime';
  const load = importer ?? ((s: string) => import(/* @vite-ignore */ s));

  let mod: { SandboxManager?: SandboxManagerLike } | undefined;
  try {
    mod = (await load(specifier)) as { SandboxManager?: SandboxManagerLike };
  } catch {
    return {
      handle: null,
      unavailable: 'not-installed',
      detail:
        'OS sandbox not in use: @anthropic-ai/sandbox-runtime is not installed (it is an ' +
        'optional dependency). Install it to sandbox scanned servers; without it the scan ' +
        'runs with a disposable HOME only.',
    };
  }

  const manager = mod?.SandboxManager;
  if (manager === undefined) {
    return {
      handle: null,
      unavailable: 'not-installed',
      detail: 'OS sandbox not in use: the sandbox-runtime module exported no SandboxManager.',
    };
  }

  try {
    if (!manager.isSupportedPlatform()) {
      return {
        handle: null,
        unavailable: 'unsupported-platform',
        detail: `OS sandbox not in use: sandbox-runtime does not support ${process.platform}.`,
      };
    }
  } catch {
    return {
      handle: null,
      unavailable: 'unsupported-platform',
      detail: 'OS sandbox not in use: platform support could not be determined.',
    };
  }

  const profile = sandboxProfile(home);

  try {
    await manager.initialize(profile);
  } catch (error) {
    // Includes the Linux case where bubblewrap/socat are absent. Named, not
    // swallowed — a sandbox that failed to start must not look like one that
    // was never asked for.
    return {
      handle: null,
      unavailable: 'init-failed',
      detail:
        'OS sandbox not in use: sandbox-runtime failed to initialize ' +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'On Linux this usually means bubblewrap or socat is not installed.',
    };
  }

  return {
    detail: 'OS sandbox active (sandbox-runtime); containment is still verified independently.',
    handle: {
      mechanism: 'sandbox-runtime (Seatbelt/bubblewrap/WFP) with denyRead on credential paths',
      async wrap(command, args, cwd) {
        try {
          const quoted = [command, ...args]
            .map((part) => (/[\s"'\\]/.test(part) ? JSON.stringify(part) : part))
            .join(' ');
          return await manager.wrapWithSandboxArgv(quoted, undefined, profile, undefined, cwd);
        } catch {
          return null;
        }
      },
    },
  };
}
