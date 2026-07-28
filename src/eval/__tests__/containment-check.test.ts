/**
 * Tests for the containment self-test.
 *
 * The cases that matter are the ones where the probe CANNOT answer. A check
 * whose failure mode is "looks contained" would be worse than no check at all,
 * because it would launder an unmeasured run into a confident posture.
 */

import { describe, it, expect } from 'vitest';
import { checkContainment } from '../containment-check.js';
import { createDisposableWorkspace } from '../../connect/transports.js';

describe('checkContainment — failure directions', () => {
  it('reports NOT contained when the probe cannot be run at all', async () => {
    const result = await checkContainment({
      nodePath: '/nonexistent/definitely-not-a-binary',
      timeoutMs: 2000,
    });
    expect(result.contained).toBe(false);
    expect(result.detail).toMatch(/could not be run/i);
  });

  it('reports NOT contained when the probe produces nothing parseable', async () => {
    // `true` exits 0 with no output — stands in for a probe that runs but
    // cannot answer.
    const result = await checkContainment({ nodePath: '/usr/bin/true', timeoutMs: 2000 });
    expect(result.contained).toBe(false);
  });

  it('never throws, whatever the environment does', async () => {
    await expect(
      checkContainment({ nodePath: '/dev/null', timeoutMs: 1000 }),
    ).resolves.toBeDefined();
  });
});

describe('checkContainment — real spawn context', () => {
  it('measures the spawn context and reports a consistent verdict', async () => {
    const ws = createDisposableWorkspace();
    try {
      const result = await checkContainment({ home: ws.home, cwd: ws.cwd, timeoutMs: 8000 });

      // The verdict is whatever this machine actually permits — asserting a
      // specific answer would bake one environment's posture into the suite.
      // What must always hold is that `contained` is exactly "neither probe
      // succeeded", so the summary can never be more optimistic than its parts.
      expect(result.contained).toBe(!result.hostFileReadable && !result.externalDnsResolvable);
      expect(result.detail.length).toBeGreaterThan(0);

      // And the detail must name what was reached, so a weak result is
      // actionable rather than a bare boolean.
      if (!result.contained) {
        expect(result.detail).toMatch(/containment is absent/i);
      }
    } finally {
      ws.dispose();
    }
  }, 15_000);
});

describe('createDisposableWorkspace', () => {
  it('creates two distinct empty directories and removes them on dispose', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const ws = createDisposableWorkspace();
    expect(existsSync(ws.home)).toBe(true);
    expect(existsSync(ws.cwd)).toBe(true);
    expect(ws.home).not.toBe(ws.cwd);
    expect(readdirSync(ws.home)).toHaveLength(0);

    ws.dispose();
    expect(existsSync(ws.home)).toBe(false);
    expect(existsSync(ws.cwd)).toBe(false);

    ws.dispose(); // idempotent
  });
});
