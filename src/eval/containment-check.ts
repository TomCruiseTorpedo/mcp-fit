/**
 * Containment self-test — measures isolation instead of assuming it.
 *
 * Every claim mcp-fit made about its eval sandbox used to be an assertion in a
 * document. The `isolationPosture` field made the claim machine-readable; this
 * makes it MEASURED. Before the target server is trusted with anything, a
 * probe runs in the exact spawn context and tries the two things containment
 * is supposed to prevent:
 *
 *   1. Reading a host file outside the disposable HOME (an absolute path that
 *      exists on every POSIX box).
 *   2. Resolving an external hostname.
 *
 * If either succeeds, containment is absent — and the posture reported for the
 * run is downgraded to `none` rather than describing what was intended. That
 * inversion is the point: an isolation claim should be falsifiable by the run
 * that makes it, so a bare macOS box says "weak containment" out loud instead
 * of inheriting a promise written on a different machine.
 *
 * WHY IT PROBES THE SPAWN CONTEXT AND NOT THIS PROCESS. Checking from inside
 * the CLI would measure the CLI's own reachability, which is not the question
 * and would pass trivially. The probe is spawned the same way a target server
 * is — same command shape, same env allowlist, same cwd and HOME — so what it
 * reports is what a hostile server would actually find.
 *
 * WHAT A PASS DOES NOT MEAN. A failed read and a failed resolve are evidence of
 * *some* containment, not proof of isolation: a sandbox profile can permit
 * plenty while blocking these two. The result is therefore an input to the
 * posture, never a substitute for naming the mechanism that produced it.
 */

import { spawn } from 'node:child_process';

/** Outcome of one probe. `null` means the probe could not be run at all. */
export interface ContainmentProbe {
  /** True when the sentinel host file was readable from the spawn context. */
  hostFileReadable: boolean;
  /** True when an external hostname resolved from the spawn context. */
  externalDnsResolvable: boolean;
  /** Human-readable detail for the transcript and for operator output. */
  detail: string;
}

export interface ContainmentResult extends ContainmentProbe {
  /**
   * True only when BOTH probes were refused.
   *
   * Feeds `IsolationEvidence.selfTestVerified`. A `false` here forces the
   * reported posture to `none` regardless of what else was attempted, because
   * this is the only signal that measured the real spawn context rather than
   * describing an intention.
   */
  contained: boolean;
}

/** A file that exists on every POSIX host and lives outside any disposable HOME. */
const SENTINEL_HOST_FILE = '/etc/hosts';

/** A name that resolves anywhere with working external DNS. */
const SENTINEL_HOSTNAME = 'example.com';

/**
 * The probe body, run in the spawned context. Kept as a source string because
 * it is executed by a separate `node -e`, not imported.
 *
 * Prints a single JSON line so the parent never has to parse prose.
 */
const PROBE_SOURCE = `
const fs = require('node:fs');
const dns = require('node:dns');
let fileOk = false;
try { fs.readFileSync(${JSON.stringify(SENTINEL_HOST_FILE)}, 'utf8'); fileOk = true; } catch {}
dns.lookup(${JSON.stringify(SENTINEL_HOSTNAME)}, (err) => {
  process.stdout.write(JSON.stringify({ fileOk, dnsOk: !err }));
  process.exit(0);
});
setTimeout(() => {
  process.stdout.write(JSON.stringify({ fileOk, dnsOk: false, timedOut: true }));
  process.exit(0);
}, 3000).unref?.();
`;

export interface ContainmentCheckOptions {
  /**
   * Wraps the probe's argv/env the same way the TARGET SERVER is wrapped.
   *
   * Without this the probe measures the CLI's own context rather than the
   * spawn context the server will get, so a working sandbox would go
   * undetected and the posture would read `none` forever. Measuring the wrong
   * process is worse than not measuring: it produces a confident wrong answer.
   */
  wrap?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv } | null>;
  /** HOME handed to the probe — normally the DisposableWorkspace's. */
  home?: string;
  /** cwd for the probe — normally the DisposableWorkspace's. */
  cwd?: string;
  /** Command used to run the probe. Overridable for tests. */
  nodePath?: string;
  /** Milliseconds before the probe is abandoned. */
  timeoutMs?: number;
}

/**
 * Run the containment probe and report what the spawn context could reach.
 *
 * Never throws: a probe that cannot run is reported as NOT contained, because
 * "we could not measure" and "it is contained" must not produce the same
 * posture. Failing towards the weaker claim is the only safe direction for a
 * field whose whole purpose is to stop overstatement.
 */
export async function checkContainment(
  options: ContainmentCheckOptions = {},
): Promise<ContainmentResult> {
  const { home, cwd, nodePath = process.execPath, timeoutMs = 5000, wrap } = options;

  let env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    ...(home !== undefined ? { HOME: home } : {}),
  };
  let spawnCommand = nodePath;
  let spawnArgs: string[] = ['-e', PROBE_SOURCE];

  // Run the probe through the SAME wrapper the target server gets, so what it
  // reports is the containment the server will actually experience.
  if (wrap !== undefined) {
    const wrapped = await wrap(nodePath, spawnArgs, cwd ?? process.cwd());
    if (wrapped !== null && wrapped.argv.length > 0) {
      spawnCommand = wrapped.argv[0] as string;
      spawnArgs = wrapped.argv.slice(1);
      env = { ...(wrapped.env as Record<string, string>), ...(home !== undefined ? { HOME: home } : {}) };
    }
  }

  const raw = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        env,
        ...(cwd !== undefined ? { cwd } : {}),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }

    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
  });

  if (raw === null || raw.trim() === '') {
    return {
      contained: false,
      hostFileReadable: false,
      externalDnsResolvable: false,
      detail:
        'containment probe could not be run — reporting NOT contained, because ' +
        '"unmeasured" and "isolated" must not produce the same posture',
    };
  }

  let parsed: { fileOk?: boolean; dnsOk?: boolean };
  try {
    parsed = JSON.parse(raw) as { fileOk?: boolean; dnsOk?: boolean };
  } catch {
    return {
      contained: false,
      hostFileReadable: false,
      externalDnsResolvable: false,
      detail: `containment probe returned unparseable output — reporting NOT contained`,
    };
  }

  const hostFileReadable = parsed.fileOk === true;
  const externalDnsResolvable = parsed.dnsOk === true;
  const contained = !hostFileReadable && !externalDnsResolvable;

  const reached: string[] = [];
  if (hostFileReadable) reached.push(`read ${SENTINEL_HOST_FILE}`);
  if (externalDnsResolvable) reached.push(`resolved ${SENTINEL_HOSTNAME}`);

  return {
    contained,
    hostFileReadable,
    externalDnsResolvable,
    detail: contained
      ? `probe was refused both the ${SENTINEL_HOST_FILE} read and the ` +
        `${SENTINEL_HOSTNAME} resolve — some containment is present, which is ` +
        'evidence, not proof of isolation'
      : `probe could ${reached.join(' and ')} from the spawn context — ` +
        'containment is absent',
  };
}
