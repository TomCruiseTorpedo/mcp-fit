/**
 * Tests for the canary tripwire and transcript.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { Transcript, plantCanary } from '../transcript.js';
import { createDisposableWorkspace } from '../../connect/transports.js';

describe('plantCanary', () => {
  it('writes a credential-shaped honeypot containing a unique secret', () => {
    const ws = createDisposableWorkspace();
    try {
      const canary = plantCanary(ws.home);
      const contents = readFileSync(canary.path, 'utf8');
      expect(contents).toContain(canary.secret);
      expect(contents).toContain('aws_secret_access_key');
      expect(canary.path).toContain('.aws');
    } finally {
      ws.dispose();
    }
  });

  it('is owner-only readable', () => {
    const ws = createDisposableWorkspace();
    try {
      const canary = plantCanary(ws.home);
      expect(statSync(canary.path).mode & 0o077).toBe(0);
    } finally {
      ws.dispose();
    }
  });

  it('generates a fresh secret per run, so a hit can never be a replay', () => {
    const a = createDisposableWorkspace();
    const b = createDisposableWorkspace();
    try {
      expect(plantCanary(a.home).secret).not.toBe(plantCanary(b.home).secret);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('Transcript', () => {
  const canary = { secret: 'mcpfit-canary-deadbeef', path: '/tmp/none' };

  it('trips on the canary appearing in server output', () => {
    const t = new Transcript(canary);
    expect(t.record('from-server', 'here are your tools')).toBe(false);
    expect(t.record('from-server', `key=${canary.secret}`)).toBe(true);
    expect(t.canaryHits).toBe(1);
    expect(t.clean).toBe(false);
  });

  it('REDACTS the secret so the transcript is not a second copy of it', () => {
    const t = new Transcript(canary);
    t.record('from-server', `leaked: ${canary.secret} end`);
    const entry = t.entries()[0];
    expect(entry?.payload).not.toContain(canary.secret);
    expect(entry?.payload).toContain('«CANARY»');
    expect(entry?.canaryHit).toBe(true);
  });

  it('is append-only: entries accumulate in order with stable sequence numbers', () => {
    const t = new Transcript(canary);
    t.record('to-server', 'a');
    t.record('from-server', 'b');
    t.record('note', 'c');
    expect(t.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(t.entries().map((e) => e.direction)).toEqual(['to-server', 'from-server', 'note']);
  });

  it('reports clean when no canary is configured, without false positives', () => {
    const t = new Transcript();
    t.record('from-server', 'mcpfit-canary-anything');
    expect(t.clean).toBe(true);
  });

  it('serialises to JSONL, one entry per line', () => {
    const t = new Transcript(canary);
    t.record('to-server', 'x');
    t.record('from-server', 'y');
    const lines = t.toJsonl().trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).direction).toBe('to-server');
  });

  it('emits nothing for an empty transcript rather than a stray newline', () => {
    expect(new Transcript().toJsonl()).toBe('');
  });
});
