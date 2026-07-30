/**
 * mcp-fit CLI — B-008
 *
 * Subcommands:
 *   scan   Connect to an MCP server, lint it, score it, and emit compat.json.
 *   fix    Scan + auto-rewrite descriptions + report before/after delta.
 *   card   Score an A2A Agent Card JSON (offline; --url gates network fetch).
 *   help   Show usage.
 *
 * Usage (stdio server):
 *   mcp-fit scan [--out <dir>] -- <command> [args...]
 *   mcp-fit fix  [--out <dir>] -- <command> [args...]
 *
 * Usage (SSE/HTTP server):
 *   mcp-fit scan [--out <dir>] --sse <url>
 *   mcp-fit fix  [--out <dir>] --sse <url>
 *
 * Usage (A2A Agent Card, ADR-F):
 *   mcp-fit card <path/to/agent-card.json> [--out <dir>]
 *   mcp-fit card --url <https://agent.example.com> [--out <dir>]
 *
 * Options:
 *   --out <dir>   Directory for emitted artifacts (default: .)
 *   --sse <url>   SSE transport URL (instead of stdio `-- cmd`)
 *   --url <url>   Fetch a live Agent Card (card subcommand only; explicit
 *                 network opt-in — bare origins get /.well-known/agent-card.json)
 *
 * Spec: CLI & Distribution + A2A Agent Card Scoring (specs/mcp-fit/spec.md)
 * Owns: src/cli.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { connectClient } from './connect/client.js';
import { createTransport, createDisposableWorkspace } from './connect/transports.js';
import type { DisposableWorkspace } from './connect/transports.js';
import { checkContainment } from './eval/containment-check.js';
import { Transcript, plantCanary } from './eval/transcript.js';
import { loadSandbox } from './eval/sandbox-runtime.js';
import type { SandboxHandle } from './eval/sandbox-runtime.js';
import { introspect } from './connect/introspect.js';
import { lint } from './lint/engine.js';
import { scoreLintOnly } from './score/scorer.js';
import { emitCompat, emitEvals } from './report/emit.js';
import { rewrite } from './fix/rewriter.js';
import { revalidate } from './fix/revalidate.js';
import { computeDelta, formatDelta } from './fix/delta.js';
import type { Scorecard } from './types.js';
import { AXIS_NAMES } from './types.js';
import type { AgentCardJson, CardScorecard } from './a2a/card-types.js';
import { CARD_AXIS_NAMES } from './a2a/card-types.js';
import { scoreCardLintOnly } from './a2a/card-scorer.js';
import { emitCardCompat } from './a2a/emit.js';
import { keyStoreFromJwks, verifyCardSignature } from './a2a/verify.js';
import { guardedFetch } from './net/guard.js';

// ---------------------------------------------------------------------------
// Version — read from package.json so the banner never drifts from the
// published version. Resolves to the package root in src (tsx), dist, and the
// installed tarball alike (package.json is always shipped).
// ---------------------------------------------------------------------------

const CLI_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const USAGE = `\
mcp-fit v${CLI_VERSION} — Score and fix MCP server agent-usability.

USAGE
  mcp-fit scan [--out <dir>] -- <command> [args...]
  mcp-fit scan [--out <dir>] --sse <url>
  mcp-fit fix  [--out <dir>] -- <command> [args...]
  mcp-fit fix  [--out <dir>] --sse <url>
  mcp-fit card <path/to/agent-card.json> [--out <dir>] [--verify-keys <jwks.json>] [--verify-jku]
  mcp-fit card --url <url> [--out <dir>] [--verify-keys <jwks.json>] [--verify-jku]
  mcp-fit help

SUBCOMMANDS
  scan   Connect, lint, score, and emit compat.json to --out directory.
  fix    Scan + auto-rewrite tool descriptions + print before/after delta.
  card   Score an A2A v1.0 Agent Card (deterministic, keyless, offline by default).
  help   Show this message.

OPTIONS
  --out <dir>   Output directory for compat.json (and evals.jsonl).  [default: .]
  --sse <url>   Use SSE transport to the given URL instead of spawning a process.
  --url <url>   card only: fetch a live Agent Card over HTTPS (explicit network
                opt-in). A bare origin gets /.well-known/agent-card.json appended.
                Loopback, private and link-local destinations are refused, on
                the first hop and on every redirect.
  --verify-keys <jwks.json>
                card only: verify signatures against a local trusted JWKS
                (crypto-pinned tier — the trust anchor, ADR-F4).
  --verify-jku  card only: also fetch the header jku JWKS (crypto-jku tier;
                network opt-in — proves integrity + key possession, NOT provenance).
  --sandbox     scan/fix only: wrap the scanned server in an OS sandbox via the
                optional @anthropic-ai/sandbox-runtime dependency. Off by
                default because it needs that dependency (and, on Linux,
                bubblewrap + socat from a system package manager).
                Verified on macOS: with it the containment self-test passes
                and the reported isolationPosture rises to 'namespace'; without
                it the posture is 'none'. Enabling this never ASSERTS
                containment - the self-test still decides, so a sandbox that
                silently degrades is reported as 'none' anyway.
  --live        scan/fix only: run the LLM-driven eval harness, letting a model
                make tool CALLS against the target.
                THIS IS NOT AN EXECUTION GATE. A plain scan already spawns the
                server and runs its MCP initialize handshake, so a malicious
                server's payload can fire without this flag. --live bounds the
                ADDITIONAL blast radius of model-driven tool use, and is refused
                outright when the containment self-test finds no isolation.

EXAMPLES
  # Score a local stdio server
  mcp-fit scan -- node my-server.js

  # Score using SSE
  mcp-fit scan --sse http://localhost:3001/sse

  # Auto-fix descriptions and show delta
  mcp-fit fix -- npx -y @my-org/my-server

  # Demo strawman — clone the repo first (fixtures are NOT in the npm package):
  #   git clone https://github.com/TomCruiseTorpedo/mcp-fit && cd mcp-fit && npm i
  mcp-fit scan -- fixtures/strawman-server/node_modules/.bin/tsx fixtures/strawman-server/server.ts

  # Score a local A2A Agent Card (offline)
  mcp-fit card fixtures/agent-cards/strawman-card.json

  # Fetch and score a live Agent Card (explicit network opt-in)
  mcp-fit card --url https://agent.example.com

ARTIFACTS
  compat.json        Full MCP scorecard (validates against schemas/compat.schema.json)
  evals.jsonl        Task traces from the eval harness (empty unless --live)
  card-compat.json   A2A card scorecard (validates against schemas/card-compat.schema.json)

Axes (lower = agent unfriendly):
  namespacing               tool-choice — distinguishable, well-documented paths
  tool-selection-confusion  tool-choice — overlapping / ambiguous tools
  param-strictness          call-signature — unambiguous signatures, clear required args
  output-leanness           output-contract — typed values vs labeled prose / token bloat
  error-helpfulness         provider-only — errors that guide recovery

Card axes (mcp-fit card, all deterministic — ADR-F):
  card-completeness                 REQUIRED-field floor (proto annotations)
  skill-namespacing                 skill name/description discoverability
  skill-selection-overlap           pairwise skill id/name/tag ambiguity
  signature-hygiene                 JWS presence + structural validity (§8.4)
  security-declaration-consistency  requirements ⊆ declared schemes
  extension-hygiene                 extension URIs, descriptions, required:true gates
  interface-hygiene                 absolute HTTPS urls, known bindings, versions
`;

// ---------------------------------------------------------------------------
// Scorecard renderer (human-readable)
// ---------------------------------------------------------------------------

/** Bar of N filled dots out of 10 */
function scorebar(n: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(n)));
  return '●'.repeat(filled) + '○'.repeat(10 - filled);
}

/** Letter grade for a 1–10 score */
function grade(n: number): string {
  if (n >= 9) return 'A';
  if (n >= 7) return 'B';
  if (n >= 5) return 'C';
  if (n >= 3) return 'D';
  return 'F';
}

function renderScorecard(scorecard: Scorecard): string {
  const { server, axes, aggregate } = scorecard;
  const lines: string[] = [];

  const line = (s: string): void => void lines.push(s);
  const hr = '─'.repeat(60);

  line(`┌${hr}┐`);
  line(
    `│  mcp-fit scorecard · ${server.name} v${server.version} (${server.transport})`.padEnd(61) +
      '│',
  );
  line(`├${hr}┤`);
  line((`│  ${'Axis'.padEnd(32)} ${'Score'.padEnd(7)} ${'Grade'.padEnd(5)} Findings`).padEnd(61) + '│');
  line(`├${hr}┤`);

  for (const axis of AXIS_NAMES) {
    const axisScore = axes[axis];
    const s = axisScore.score;
    const errCnt = axisScore.findings.filter((f) => f.severity === 'error').length;
    const warnCnt = axisScore.findings.filter((f) => f.severity === 'warning').length;
    const findingStr =
      s === null
        ? 'eval-only (run --eval)'
        : errCnt > 0 || warnCnt > 0
          ? `${errCnt}err ${warnCnt}warn`
          : 'clean';
    // Eval-only axes carry no deterministic grade — render a dash, never a 10.
    const scoreCol = s === null ? '—' : `${s}`;
    const gradeCol = s === null ? '·' : grade(s);
    const row =
      `│  ${axis.padEnd(32)} ${scoreCol.padEnd(3)}/10  ${gradeCol.padEnd(4)}  ${findingStr}`;
    line(row.padEnd(61) + '│');
  }

  line(`├${hr}┤`);

  const lintStr = `│  LINT SCORE (deterministic)   ${aggregate.lintScore.toFixed(1)} / 10`;
  line(lintStr.padEnd(61) + '│');

  if (aggregate.evalScore) {
    const es = aggregate.evalScore;
    const evalStr = `│  EVAL SCORE (stochastic)      ${es.mean.toFixed(1)} ± ${es.stdev.toFixed(2)} (n=${es.n})`;
    line(evalStr.padEnd(61) + '│');
    const wStr = `│  WEIGHTED AGGREGATE           ${aggregate.weighted.toFixed(1)} / 10`;
    line(wStr.padEnd(61) + '│');
  } else {
    const wStr = `│  WEIGHTED AGGREGATE           ${aggregate.weighted.toFixed(1)} / 10  [grade: ${grade(aggregate.weighted)}]`;
    line(wStr.padEnd(61) + '│');
  }

  line(`└${hr}┘`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Argument parser (no external dependencies)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: 'scan' | 'fix' | 'card' | 'help';
  outDir: string;
  sse: string | null;
  /** The spawned-server argv (everything after `--`). */
  serverArgv: string[];
  /** card: local Agent Card JSON path (offline). */
  cardPath: string | null;
  /** card: live Agent Card URL (explicit network opt-in, ADR-F6). */
  cardUrl: string | null;
  /** card: JWKS file for the crypto-pinned verification tier (ADR-F4). */
  cardVerifyKeys: string | null;
  /** card: opt into fetching the header jku JWKS (crypto-jku tier, network). */
  cardVerifyJku: boolean;
  /** scan/fix: opt into the OS sandbox (optional dependency; raises the measured posture). */
  sandbox: boolean;
  /**
   * scan/fix: opt into the LLM-driven eval harness.
   *
   * Gates the agent making tool CALLS against the target. It does NOT make the
   * default execution-free — a plain `scan` already spawns the server process
   * and runs the MCP initialize handshake, so a malicious server's payload can
   * fire without this flag. What `--live` bounds is the ADDITIONAL blast radius
   * of letting a model drive that server's tools.
   */
  live: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(0); // copy — we consume it
  let subcommand: ParsedArgs['subcommand'] = 'help';
  let outDir = '.';
  let sse: string | null = null;
  let serverArgv: string[] = [];
  let cardPath: string | null = null;
  let cardUrl: string | null = null;
  let cardVerifyKeys: string | null = null;
  let cardVerifyJku = false;
  let live = false;
  let sandbox = false;

  if (args.length === 0) {
    return {
      subcommand: 'help', outDir, sse, serverArgv, cardPath, cardUrl,
      cardVerifyKeys, cardVerifyJku, live, sandbox,
    };
  }

  const sub = args.shift()!;
  if (sub === 'scan') subcommand = 'scan';
  else if (sub === 'fix') subcommand = 'fix';
  else if (sub === 'card') subcommand = 'card';
  else if (sub === 'help' || sub === '--help' || sub === '-h') subcommand = 'help';
  else {
    process.stderr.write(`mcp-fit: unknown subcommand '${sub}'. Run 'mcp-fit help'.\n`);
    process.exit(1);
  }

  if (subcommand === 'card') {
    for (let j = 0; j < args.length; j++) {
      const a = args[j]!;
      if (a === '--out' || a === '-o') {
        const v = args[++j];
        if (!v) {
          process.stderr.write(`mcp-fit: --out requires a directory argument\n`);
          process.exit(1);
        }
        outDir = v;
      } else if (a.startsWith('--out=')) {
        outDir = a.slice('--out='.length);
      } else if (a === '--url') {
        const v = args[++j];
        if (!v) {
          process.stderr.write(`mcp-fit: --url requires a URL argument\n`);
          process.exit(1);
        }
        cardUrl = v;
      } else if (a.startsWith('--url=')) {
        cardUrl = a.slice('--url='.length);
      } else if (a === '--verify-keys') {
        const v = args[++j];
        if (!v) {
          process.stderr.write(`mcp-fit: --verify-keys requires a JWKS file path\n`);
          process.exit(1);
        }
        cardVerifyKeys = v;
      } else if (a.startsWith('--verify-keys=')) {
        cardVerifyKeys = a.slice('--verify-keys='.length);
      } else if (a === '--verify-jku') {
        cardVerifyJku = true;
      } else if (a.startsWith('--')) {
        process.stderr.write(`mcp-fit: unknown option '${a}'. Run 'mcp-fit help'.\n`);
        process.exit(1);
      } else if (cardPath === null) {
        cardPath = a;
      } else {
        process.stderr.write(`mcp-fit: card takes a single path argument (got '${a}').\n`);
        process.exit(1);
      }
    }
    return {
      subcommand, outDir, sse, serverArgv, cardPath, cardUrl,
      cardVerifyKeys, cardVerifyJku, live, sandbox,
    };
  }

  // Parse options until `--` separator
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--out' || a === '-o') {
      const v = args[++i];
      if (!v) {
        process.stderr.write(`mcp-fit: --out requires a directory argument\n`);
        process.exit(1);
      }
      outDir = v;
    } else if (a.startsWith('--out=')) {
      outDir = a.slice('--out='.length);
    } else if (a === '--sse') {
      const v = args[++i];
      if (!v) {
        process.stderr.write(`mcp-fit: --sse requires a URL argument\n`);
        process.exit(1);
      }
      sse = v;
    } else if (a.startsWith('--sse=')) {
      sse = a.slice('--sse='.length);
    } else if (a === '--live') {
      live = true;
    } else if (a === '--sandbox') {
      sandbox = true;
    } else {
      process.stderr.write(`mcp-fit: unknown option '${a}'. Run 'mcp-fit help'.\n`);
      process.exit(1);
    }
  }

  // Everything remaining is the server command
  serverArgv = args.slice(i);

  return {
    subcommand, outDir, sse, serverArgv, cardPath, cardUrl,
    cardVerifyKeys, cardVerifyJku, live, sandbox,
  };
}

// ---------------------------------------------------------------------------
// Transport resolver
// ---------------------------------------------------------------------------

async function resolveTransport(
  sse: string | null,
  serverArgv: string[],
  workspace?: DisposableWorkspace,
  sandbox?: SandboxHandle | null,
): Promise<ReturnType<typeof createTransport> & { kind: 'stdio' | 'sse' }> {
  if (sse) {
    const t = createTransport({ kind: 'sse', url: sse });
    // tag the transport kind for introspect()
    (t as unknown as { _kind: string })['_kind'] = 'sse';
    return Object.assign(t, { kind: 'sse' as const });
  }

  if (serverArgv.length === 0) {
    process.stderr.write(
      `mcp-fit: no server specified. Provide '-- <command> [args]' or '--sse <url>'.\n`,
    );
    process.exit(1);
  }

  const [command, ...args] = serverArgv;
  // A spawned server gets a disposable HOME when one is supplied, so
  // HOME-relative reads land in an empty temp dir rather than the operator's
  // ~/.aws, ~/.ssh or ~/.npmrc. Absolute paths still resolve — see the note on
  // createDisposableWorkspace; this raises the floor, it does not isolate.
  //
  // The cwd is deliberately left alone: the operator names the server with
  // paths relative to their own directory, including in ARGUMENTS, which
  // cannot be rewritten safely. That note lives on createDisposableWorkspace.
  // When an OS sandbox is available, it rewrites the spawn into a wrapped
  // argv/env. When it is not, the command is spawned as before with only a
  // disposable HOME. Either way the containment self-test decides the posture
  // — being wrapped is not itself evidence of being contained.
  let spawnCommand = command!;
  let spawnArgs = [...args];
  let spawnEnv: Record<string, string> | undefined =
    workspace !== undefined
      ? ({ ...process.env, HOME: workspace.home } as Record<string, string>)
      : undefined;

  if (sandbox != null && workspace !== undefined) {
    const wrapped = await sandbox.wrap(command!, args, workspace.home);
    if (wrapped !== null && wrapped.argv.length > 0) {
      spawnCommand = wrapped.argv[0] as string;
      spawnArgs = wrapped.argv.slice(1);
      spawnEnv = { ...(wrapped.env as Record<string, string>), HOME: workspace.home };
    } else {
      process.stderr.write(
        'mcp-fit: sandbox wrapping failed; falling back to an unwrapped spawn. The ' +
          'containment self-test will report the posture that actually applies.\n',
      );
    }
  }

  const t = createTransport({
    kind: 'stdio',
    command: spawnCommand,
    args: spawnArgs,
    ...(spawnEnv !== undefined ? { env: spawnEnv } : {}),
  });
  return Object.assign(t, { kind: 'stdio' as const });
}

// ---------------------------------------------------------------------------
// scan implementation
// ---------------------------------------------------------------------------

async function cmdScan(opts: ParsedArgs): Promise<void> {
  const { outDir, sse, serverArgv } = opts;

  // A spawned server gets a disposable HOME and cwd. Remote (SSE) servers are
  // not ours to contain — there is no process here to give a workspace to.
  const workspace = sse ? undefined : createDisposableWorkspace();

  // Measure containment BEFORE trusting the target with anything, in the same
  // spawn context the target will get. The result is reported as the run's
  // isolation posture rather than assumed — a bare box says "weak" out loud
  // instead of inheriting a promise written on some other machine.
  // Plant a credential honeypot in the disposable HOME before the server ever
  // runs. Nothing legitimate reads it, so the value coming back through the
  // MCP channel is proof the server went looking for credentials.
  const canary = workspace ? plantCanary(workspace.home) : undefined;
  const transcript = new Transcript(canary);

  // Optional OS sandbox. Absent, unsupported or failed-to-start all fall back
  // to the unwrapped spawn — reported, never silent.
  // Opt-in: it needs an optional dependency, and on Linux system packages
  // besides. When present it raises the measured posture to `namespace`;
  // when absent everything falls back to the disposable-HOME path and says so.
  const sandbox = workspace && opts.sandbox ? await loadSandbox(workspace.home) : null;
  if (sandbox !== null) process.stderr.write(`mcp-fit: ${sandbox.detail}\n`);

  // The self-test runs through the SAME wrapper the server gets. Probing an
  // unwrapped process would measure the CLI's own reachability and report
  // `none` even when the sandbox works.
  const containment = workspace
    ? await checkContainment({
        home: workspace.home,
        cwd: workspace.cwd,
        ...(sandbox?.handle != null
          ? { wrap: (c, a, cw) => sandbox.handle!.wrap(c, a, cw) }
          : {}),
      })
    : undefined;
  transcript.record(
    'note',
    containment ? `containment: ${containment.detail}` : 'containment: not probed (remote server)',
  );

  if (containment !== undefined && !containment.contained) {
    process.stderr.write(
      `mcp-fit: containment self-test — NOT contained (${containment.detail})\n`,
    );
  }

  if (opts.live && containment !== undefined && !containment.contained) {
    // Refuse loudly. --live hands a model the target's tools; doing that with
    // measured-absent containment is the combination the whole isolation stack
    // exists to prevent.
    workspace?.dispose();
    throw new Error(
      'refusing --live: the containment self-test found no isolation in the spawn ' +
        `context (${containment.detail}). The eval agent would drive an untrusted ` +
        'server with full host filesystem and network reach as this user. Run without ' +
        '--live to score statically, or provide an OS-level sandbox.',
    );
  }

  const transport = await resolveTransport(sse, serverArgv, workspace, sandbox?.handle ?? null);
  const transportKind = transport.kind;

  process.stderr.write(`mcp-fit: connecting to server (${transportKind})...\n`);

  const client = await connectClient(transport, transportKind);

  try {
    process.stderr.write(`mcp-fit: introspecting...\n`);
    const server = await introspect(client, transportKind);

    process.stderr.write(
      `mcp-fit: found ${server.tools.length} tool(s), ${server.resources.length} resource(s), ${server.prompts.length} prompt(s)\n`,
    );

    // Scan what the server told us for the canary. This covers the stdio
    // channel only — a server that reads the honeypot and POSTs it itself is
    // invisible here, and a silent canary means "not caught on this channel",
    // never "no exfiltration occurred".
    transcript.record('from-server', JSON.stringify(server));
    if (!transcript.clean) {
      process.stderr.write(
        `mcp-fit: CANARY TRIPPED — the server returned the contents of a honeypot ` +
          `credentials file planted in its HOME. It read credentials it had no reason ` +
          `to touch. Treat this server as hostile.\n`,
      );
    }

    process.stderr.write(`mcp-fit: linting...\n`);
    const lintResult = lint(server.tools);

    const scorecard = scoreLintOnly(server.server, lintResult);

    // Emit artifacts
    const absOut = resolve(outDir);
    await mkdir(absOut, { recursive: true });

    const compatPath = join(absOut, 'compat.json');
    const evalsPath = join(absOut, 'evals.jsonl');
    const transcriptPath = join(absOut, 'transcript.jsonl');

    // The posture written into compat.json is derived from what was actually
    // done and actually measured — never from what was intended.
    await emitCompat(scorecard, compatPath, {
      disposableHome: workspace !== undefined,
      // Naming the mechanism does NOT assert it worked — a failed self-test
      // still forces the posture to `none`. See report/emit.ts.
      ...(sandbox?.handle != null ? { osSandbox: sandbox.handle.mechanism } : {}),
      ...(containment !== undefined ? { selfTestVerified: containment.contained } : {}),
    });
    await emitEvals([], evalsPath); // no eval traces in scan-only mode
    await writeFile(transcriptPath, transcript.toJsonl(), 'utf8');

    // Print human-readable scorecard
    process.stdout.write(renderScorecard(scorecard) + '\n');
    process.stderr.write(`\nmcp-fit: artifacts written to ${absOut}/\n`);
    process.stderr.write(`  compat.json   (scorecard, incl. isolationPosture)\n`);
    process.stderr.write(
      `  transcript.jsonl (what the scan observed; canary ${transcript.clean ? 'silent' : 'TRIPPED'})\n`,
    );
    process.stderr.write(
      `  evals.jsonl   (task traces — empty; --live runs the LLM-driven eval harness.\n` +
        `                 NOTE: --live gates the agent's tool CALLS, not execution —\n` +
        `                 this scan already spawned the server and ran its handshake)\n`,
    );
  } finally {
    workspace?.dispose();
    await client.close().catch(() => {
      // Ignore close errors — server process may have already exited.
    });
  }
}

// ---------------------------------------------------------------------------
// card implementation (ADR-F)
// ---------------------------------------------------------------------------

function renderCardScorecard(scorecard: CardScorecard): string {
  const { card, axes, aggregate, signature } = scorecard;
  const lines: string[] = [];

  const line = (s: string): void => void lines.push(s);
  const hr = '─'.repeat(60);

  line(`┌${hr}┐`);
  line(`│  mcp-fit card scorecard · ${card.name} v${card.version}`.padEnd(61) + '│');
  line(`├${hr}┤`);
  line((`│  ${'Axis'.padEnd(34)} ${'Score'.padEnd(7)} ${'Grade'.padEnd(5)} Findings`).padEnd(61) + '│');
  line(`├${hr}┤`);

  for (const axis of CARD_AXIS_NAMES) {
    const axisScore = axes[axis];
    const errCnt = axisScore.findings.filter((f) => f.severity === 'error').length;
    const warnCnt = axisScore.findings.filter((f) => f.severity === 'warning').length;
    const findingStr = errCnt > 0 || warnCnt > 0 ? `${errCnt}err ${warnCnt}warn` : 'clean';
    const row =
      `│  ${axis.padEnd(34)} ${String(axisScore.score).padEnd(3)}/10  ${grade(axisScore.score).padEnd(4)}  ${findingStr}`;
    line(row.padEnd(61) + '│');
  }

  line(`├${hr}┤`);
  const sigStr = signature.present
    ? signature.tier === 'crypto-pinned' || signature.tier === 'crypto-jku'
      ? `signed — VERIFIED (${signature.tier})`
      : signature.tier === 'structural'
        ? 'signed — structural (crypto unverified)'
        : 'signed — verification FAILED'
    : 'unsigned';
  line(`│  SIGNATURE                      ${sigStr}`.padEnd(61) + '│');
  const wStr = `│  CARD LINT SCORE (deterministic)  ${aggregate.lintScore.toFixed(1)} / 10  [grade: ${grade(aggregate.lintScore)}]`;
  line(wStr.padEnd(61) + '│');
  line(`└${hr}┘`);

  return lines.join('\n');
}

/** Resolve the effective card URL: bare origins get the well-known path (§8.2). */
function resolveCardUrl(raw: string): string {
  const parsed = new URL(raw); // throws on invalid — caught by main()
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/.well-known/agent-card.json';
  }
  return parsed.toString();
}

async function cmdCard(opts: ParsedArgs): Promise<void> {
  const { outDir, cardPath, cardUrl } = opts;

  if (cardPath !== null && cardUrl !== null) {
    process.stderr.write(`mcp-fit: card takes a path OR --url, not both.\n`);
    process.exit(1);
  }
  if (cardPath === null && cardUrl === null) {
    process.stderr.write(
      `mcp-fit: card needs an agent-card.json path, or --url <url> to fetch one.\n`,
    );
    process.exit(1);
  }

  let raw: string;
  if (cardPath !== null) {
    // Offline path — no network (spec: A2A Agent Card Scoring, scenario "offline by default").
    raw = readFileSync(resolve(cardPath), 'utf8');
  } else {
    const target = resolveCardUrl(cardUrl!);
    process.stderr.write(`mcp-fit: fetching ${target} ...\n`);
    // Guarded: refuses loopback / RFC1918 / link-local (the cloud metadata
    // endpoint) destinations before any request is made, and re-checks every
    // redirect hop. See src/net/guard.ts.
    //
    // NO ESCAPE HATCH HERE, AND THAT IS DELIBERATE (decided 2026-07-28).
    // Scoring an agent you are running yourself is already a first-class path:
    // save the card and use the offline form above. So the only thing a
    // `--allow-private-network` flag would buy is skipping one `curl` — and a
    // flag that switches off an SSRF guard gets pasted into scripts by people
    // who hit the error and searched for how to stop it, after which it
    // applies to every URL that script fetches, third-party ones included.
    //
    // If this ever genuinely blocks someone, the pre-decided answer is
    // LOOPBACK ONLY (127.0.0.0/8 and ::1) — not `allowPrivate`, which would
    // also open 169.254.169.254, all of RFC1918, and the CGNAT/tailnet range
    // in order to reach localhost. Do not reach for the broad switch.
    const response = await guardedFetch(target, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`fetching agent card failed: HTTP ${response.status} for ${target}`);
    }
    raw = await response.text();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `input is not valid JSON — an Agent Card must be a single JSON document`,
    );
  }

  const scorecard = scoreCardLintOnly(parsed);

  // Crypto verification tiers (ADR-F4) — only when explicitly requested.
  if (opts.cardVerifyKeys !== null || opts.cardVerifyJku) {
    const keyStore =
      opts.cardVerifyKeys !== null
        ? keyStoreFromJwks(JSON.parse(readFileSync(resolve(opts.cardVerifyKeys), 'utf8')))
        : undefined;
    process.stderr.write(
      `mcp-fit: verifying signatures (${[
        keyStore !== undefined ? 'pinned key store' : null,
        opts.cardVerifyJku ? 'jku fetch enabled' : null,
      ]
        .filter(Boolean)
        .join(' + ')})...\n`,
    );
    scorecard.signature = await verifyCardSignature(parsed as AgentCardJson, {
      ...(keyStore !== undefined ? { keyStore } : {}),
      fetchJku: opts.cardVerifyJku,
    });
  }

  const absOut = resolve(outDir);
  await mkdir(absOut, { recursive: true });
  const cardCompatPath = join(absOut, 'card-compat.json');
  await emitCardCompat(scorecard, cardCompatPath);

  process.stdout.write(renderCardScorecard(scorecard) + '\n');
  process.stderr.write(`\nmcp-fit: artifacts written to ${absOut}/\n`);
  process.stderr.write(`  card-compat.json   (card scorecard)\n`);
}

// ---------------------------------------------------------------------------
// fix implementation
// ---------------------------------------------------------------------------

async function cmdFix(opts: ParsedArgs): Promise<void> {
  const { outDir, sse, serverArgv } = opts;

  const transport = await resolveTransport(sse, serverArgv);
  const transportKind = transport.kind;

  process.stderr.write(`mcp-fit: connecting to server (${transportKind})...\n`);

  const client = await connectClient(transport, transportKind);

  try {
    process.stderr.write(`mcp-fit: introspecting...\n`);
    const server = await introspect(client, transportKind);

    process.stderr.write(
      `mcp-fit: found ${server.tools.length} tool(s) — linting before fix...\n`,
    );

    const beforeLint = lint(server.tools);
    const beforeScorecard = scoreLintOnly(server.server, beforeLint);

    process.stdout.write('=== BEFORE ===\n');
    process.stdout.write(renderScorecard(beforeScorecard) + '\n');

    process.stderr.write(`mcp-fit: generating description overrides...\n`);
    const rewriteResult = await rewrite(server.tools, beforeLint);

    if (!rewriteResult.hasImprovements) {
      process.stdout.write(`\nmcp-fit fix: ${rewriteResult.message}\n`);
      return;
    }

    process.stderr.write(`mcp-fit: re-linting with overrides applied...\n`);
    const { lintResult: afterLint } = revalidate(server, rewriteResult.overrides);
    const afterScorecard = scoreLintOnly(server.server, afterLint);

    process.stdout.write('\n=== AFTER ===\n');
    process.stdout.write(renderScorecard(afterScorecard) + '\n');

    const delta = computeDelta(beforeLint, afterLint);
    process.stdout.write('\n=== DELTA ===\n');
    process.stdout.write(formatDelta(delta) + '\n');

    // Emit the after-fix scorecard
    const absOut = resolve(outDir);
    await mkdir(absOut, { recursive: true });

    const compatPath = join(absOut, 'compat.json');
    const evalsPath = join(absOut, 'evals.jsonl');
    const transcriptPath = join(absOut, 'transcript.jsonl');

    await emitCompat(afterScorecard, compatPath);
    await emitEvals([], evalsPath);

    process.stderr.write(`\nmcp-fit: artifacts written to ${absOut}/\n`);
  } finally {
    await client.close().catch(() => {
      // Ignore close errors.
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts = parseCliArgs(args);

  switch (opts.subcommand) {
    case 'help':
      process.stdout.write(USAGE + '\n');
      return;

    case 'scan':
      await cmdScan(opts);
      return;

    case 'fix':
      await cmdFix(opts);
      return;

    case 'card':
      await cmdCard(opts);
      return;
  }
}

// Auto-run when invoked directly (bin/mcp-fit → dist/cli.js)
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mcp-fit: error: ${msg}\n`);
  process.exit(1);
});
