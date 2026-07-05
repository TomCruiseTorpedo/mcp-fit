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

import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { connectClient } from './connect/client.js';
import { createTransport } from './connect/transports.js';
import { introspect } from './connect/introspect.js';
import { lint } from './lint/engine.js';
import { scoreLintOnly } from './score/scorer.js';
import { emitCompat, emitEvals } from './report/emit.js';
import { rewrite } from './fix/rewriter.js';
import { revalidate } from './fix/revalidate.js';
import { computeDelta, formatDelta } from './fix/delta.js';
import type { Scorecard } from './types.js';
import { AXIS_NAMES } from './types.js';
import type { CardScorecard } from './a2a/card-types.js';
import { CARD_AXIS_NAMES } from './a2a/card-types.js';
import { scoreCardLintOnly } from './a2a/card-scorer.js';
import { emitCardCompat } from './a2a/emit.js';

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
  mcp-fit card <path/to/agent-card.json> [--out <dir>]
  mcp-fit card --url <url> [--out <dir>]
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
  evals.jsonl        Task traces from dynamic eval (empty when eval is skipped)
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
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(0); // copy — we consume it
  let subcommand: ParsedArgs['subcommand'] = 'help';
  let outDir = '.';
  let sse: string | null = null;
  let serverArgv: string[] = [];
  let cardPath: string | null = null;
  let cardUrl: string | null = null;

  if (args.length === 0) {
    return { subcommand: 'help', outDir, sse, serverArgv, cardPath, cardUrl };
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
    return { subcommand, outDir, sse, serverArgv, cardPath, cardUrl };
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
    } else {
      process.stderr.write(`mcp-fit: unknown option '${a}'. Run 'mcp-fit help'.\n`);
      process.exit(1);
    }
  }

  // Everything remaining is the server command
  serverArgv = args.slice(i);

  return { subcommand, outDir, sse, serverArgv, cardPath, cardUrl };
}

// ---------------------------------------------------------------------------
// Transport resolver
// ---------------------------------------------------------------------------

function resolveTransport(
  sse: string | null,
  serverArgv: string[],
): ReturnType<typeof createTransport> & { kind: 'stdio' | 'sse' } {
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
  const t = createTransport({ kind: 'stdio', command: command!, args });
  return Object.assign(t, { kind: 'stdio' as const });
}

// ---------------------------------------------------------------------------
// scan implementation
// ---------------------------------------------------------------------------

async function cmdScan(opts: ParsedArgs): Promise<void> {
  const { outDir, sse, serverArgv } = opts;

  const transport = resolveTransport(sse, serverArgv);
  const transportKind = transport.kind;

  process.stderr.write(`mcp-fit: connecting to server (${transportKind})...\n`);

  const client = await connectClient(transport, transportKind);

  try {
    process.stderr.write(`mcp-fit: introspecting...\n`);
    const server = await introspect(client, transportKind);

    process.stderr.write(
      `mcp-fit: found ${server.tools.length} tool(s), ${server.resources.length} resource(s), ${server.prompts.length} prompt(s)\n`,
    );

    process.stderr.write(`mcp-fit: linting...\n`);
    const lintResult = lint(server.tools);

    const scorecard = scoreLintOnly(server.server, lintResult);

    // Emit artifacts
    const absOut = resolve(outDir);
    await mkdir(absOut, { recursive: true });

    const compatPath = join(absOut, 'compat.json');
    const evalsPath = join(absOut, 'evals.jsonl');

    await emitCompat(scorecard, compatPath);
    await emitEvals([], evalsPath); // no eval traces in scan-only mode

    // Print human-readable scorecard
    process.stdout.write(renderScorecard(scorecard) + '\n');
    process.stderr.write(`\nmcp-fit: artifacts written to ${absOut}/\n`);
    process.stderr.write(`  compat.json   (scorecard)\n`);
    process.stderr.write(`  evals.jsonl   (task traces — empty; run with --eval to populate)\n`);
  } finally {
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
    ? signature.tier !== null
      ? `signed — ${signature.tier} (crypto unverified)`
      : 'signed — structurally INVALID'
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
    const response = await fetch(target, {
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

  const transport = resolveTransport(sse, serverArgv);
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
