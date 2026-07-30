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
 * Settings handed to SRT for a scan. Network is denied outright.
 *
 * ⚠️ NOT YET CALIBRATED FOR REAL SERVERS — this is why `--sandbox` is opt-in.
 *
 * The read-deny half is verified: with `denyRead` set, mcp-fit's own probe
 * reports `contained: true` where the SRT default leaves `/etc/hosts`,
 * `~/.ssh` and `~/.aws` readable. That part works.
 *
 * The RUN half does not yet. A Node toolchain target (`tsx`) fails with
 * `EPERM` binding its IPC unix socket under this profile, and three attempts
 * did not resolve it — widening `allowWrite` to the temp dirs, scoping
 * `allowUnixSockets` to `/tmp/**`, and enabling `allowLocalBinding` each left
 * it failing. The remaining suspects are macOS `/tmp` → `/private/tmp` symlink
 * resolution inside Seatbelt, and whether SRT's unix-socket path patterns
 * apply to `bind` as well as `connect`.
 *
 * This is the cost originally flagged for D2 and then wrongly downgraded after
 * `denyRead` worked: choosing what to DENY is easy; making legitimate servers
 * still start is the hard half. Until it is settled, a profile that prevents
 * the target from launching is a broken scanner, not a contained one — which
 * is why nothing here runs unless the operator asks for it.
 */
export function sandboxProfile(home: string): Record<string, unknown> {
  return {
    network: {
      // A scanned server has no legitimate need to reach the internet through
      // us. Anything it does need, it can be granted deliberately later.
      allowedDomains: [],
      deniedDomains: [],
      // Node toolchains use unix-domain sockets for IPC — `tsx` creates one
      // per run — and SRT blocks unix sockets by DEFAULT. Leaving them blocked
      // makes real servers fail to start at all, which is a broken scanner
      // rather than a contained one. Scoped to temp dirs, not opened globally,
      // so things like /var/run/docker.sock stay blocked.
      allowUnixSockets: ['/tmp/**', '/private/tmp/**', '/var/folders/**'],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [...DENY_READ_PATHS],
      allowRead: [],
      // Writes: the disposable HOME, the cwd, and /tmp.
      //
      // /tmp is NOT optional and was learned the hard way — a first attempt
      // confined writes to the disposable HOME alone and real toolchains
      // failed immediately (`tsx` could not create its IPC pipe, so the scan
      // died before it introspected anything). A profile so tight that
      // legitimate servers cannot start makes the scanner useless, and a
      // scanner that reports failures which are not failures gets ignored.
      //
      // The security value here is in denyRead, not in write confinement: the
      // threat is a server harvesting credentials, and credentials are read.
      allowWrite: [home, '.', '/tmp', '/private/tmp', '/var/folders'],
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
