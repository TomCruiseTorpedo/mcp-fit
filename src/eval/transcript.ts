/**
 * Canary tripwire and append-only transcript.
 *
 * Two cheap observability primitives for a scan of an untrusted server.
 *
 * THE CANARY. A unique secret is planted in the disposable HOME, in a file a
 * credential-harvesting server would go looking for (`~/.aws/credentials`).
 * Nothing legitimate has any reason to read it, so the value appearing anywhere
 * in the server's output is proof that the server went hunting for credentials
 * — not an inference from behaviour, but the string itself, which cannot be
 * argued with.
 *
 * WHAT THE CANARY CAN AND CANNOT SEE — the honest bound, stated because the
 * temptation is to describe this as exfiltration detection. mcp-fit observes
 * the STDIO channel between itself and the server. It does not intercept the
 * server's own sockets and has no way to; that would need an OS-level network
 * sandbox. So this catches a server that reads the honeypot and sends the value
 * BACK THROUGH ITS MCP RESPONSES — sloppy or opportunistic harvesting, which is
 * a real and common shape. It does NOT catch a server that reads the file and
 * POSTs it somewhere itself. A silent canary means "not caught on this
 * channel", never "no exfiltration occurred".
 *
 * THE TRANSCRIPT is append-only in the sense that matters here: entries are
 * only ever pushed, never edited or removed, so the record of what a scan saw
 * cannot be quietly revised after the fact by the code that produced it. It is
 * evidence for an operator, not a tamper-evident log — there is no hash chain
 * and it makes no claim against a hostile local user.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** A planted secret and where it was planted. */
export interface Canary {
  /** The unique value. Its appearance in server output is the tripwire. */
  secret: string;
  /** Absolute path of the honeypot file. */
  path: string;
}

/**
 * Plant a canary credential inside `homeDir`.
 *
 * The file is shaped like a real AWS credentials file because that is what a
 * harvester greps for; the value is random per run, so a hit can never be a
 * coincidence or a replay from an earlier scan.
 */
export function plantCanary(homeDir: string): Canary {
  const secret = `mcpfit-canary-${randomBytes(24).toString('hex')}`;
  const path = join(homeDir, '.aws', 'credentials');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `[default]\naws_access_key_id = AKIA${randomBytes(8).toString('hex').toUpperCase()}\n` +
      `aws_secret_access_key = ${secret}\n`,
    { mode: 0o600 },
  );
  return { secret, path };
}

/** One observed event. */
export interface TranscriptEntry {
  /** Monotonic sequence number within the run. */
  seq: number;
  /** Which way the bytes were going, from mcp-fit's point of view. */
  direction: 'to-server' | 'from-server' | 'note';
  /** The payload, or a note. */
  payload: string;
  /** True when this entry contained the canary value. */
  canaryHit: boolean;
}

/**
 * Append-only record of what a scan observed, with canary matching on the way
 * in so a hit is noticed at the moment it happens rather than on a later pass.
 */
export class Transcript {
  readonly #entries: TranscriptEntry[] = [];
  readonly #secret: string | undefined;
  #hits = 0;

  constructor(canary?: Canary) {
    this.#secret = canary?.secret;
  }

  /** Record an observation. Returns true when it tripped the canary. */
  record(direction: TranscriptEntry['direction'], payload: string): boolean {
    const canaryHit = this.#secret !== undefined && payload.includes(this.#secret);
    if (canaryHit) this.#hits += 1;
    this.#entries.push({
      seq: this.#entries.length,
      direction,
      // Redact the secret itself so the transcript cannot become a second copy
      // of the thing it exists to protect.
      payload: canaryHit && this.#secret !== undefined
        ? payload.split(this.#secret).join('«CANARY»')
        : payload,
      canaryHit,
    });
    return canaryHit;
  }

  /** Number of entries that contained the canary. */
  get canaryHits(): number {
    return this.#hits;
  }

  /** True when the canary was never seen. NOT a proof of no exfiltration. */
  get clean(): boolean {
    return this.#hits === 0;
  }

  /** All entries, in observation order. */
  entries(): readonly TranscriptEntry[] {
    return this.#entries;
  }

  /** Serialise as JSONL — one entry per line, append order preserved. */
  toJsonl(): string {
    return this.#entries.map((e) => JSON.stringify(e)).join('\n') + (this.#entries.length ? '\n' : '');
  }
}
