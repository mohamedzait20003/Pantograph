import type { Server } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '@pantograph/target';
import { CapabilitySchema, type Capability, type PolicyConfig, type ReplayResult } from '@pantograph/core';

import { PlaywrightWebSurface } from '../src/surface/playwright.js';
import { replay, type ReplayOptions } from '../src/replay/engine.js';
import { FilesystemEvidenceStore } from '../src/replay/evidence.js';
import { MemoryJournal } from '../src/replay/journal.js';

import fixtureJson from '../../../packages/core/test/fixtures/member-savings-balance.json';

/**
 * End-to-end against the real target app, in-process. The point of these is
 * the taxonomy: the same engine, the same artifact, different inputs and
 * injected conditions, and three distinct result shapes come out. A mocked
 * surface would let the engine pass while proving nothing about that.
 */

let server: Server | null = null;
let surface: PlaywrightWebSurface | null = null;
let baseUrl = '';
let evidenceDir = '';
let skipReason = '';

try {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', () => resolve());
    server?.once('error', reject);
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server has no address');
  baseUrl = `http://localhost:${address.port}`;

  evidenceDir = await mkdtemp(path.join(tmpdir(), 'pantograph-evidence-'));

  surface = await PlaywrightWebSurface.launch({
    baseUrl,
    headless: process.env.PANTOGRAPH_HEADED !== '1',
    // slow_load stacks a 6s delay on every request in the flow; the settle
    // after a click has to outlast a delayed POST plus a delayed redirect.
    actionTimeoutMs: 30_000,
  });
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error);
  server?.close();
}

if (surface === null) {
  console.warn(`[replay.test] skipped - ${skipReason}.`);
}

const fixture: Capability = CapabilitySchema.parse(fixtureJson);

function policy(): PolicyConfig {
  return {
    allowedHosts: [new URL(baseUrl).host],
    allowedRoutes: ['/', '/search', '/member/:id', '/member/:id/subaccount'],
    allowedActions: ['navigate', 'click', 'type', 'select', 'extract', 'assert'],
    maxSteps: 50,
    timeoutMs: 120_000,
  };
}

function live(): PlaywrightWebSurface {
  if (surface === null) throw new Error('surface unavailable');
  return surface;
}

async function run(
  inputs: Record<string, unknown>,
  options: ReplayOptions = {},
  artifact: Capability = fixture,
): Promise<{ result: ReplayResult; journal: MemoryJournal }> {
  const journal = new MemoryJournal();
  const result = await replay(
    artifact,
    inputs,
    {
      surface: live(),
      journal,
      evidence: new FilesystemEvidenceStore(evidenceDir),
      policy: policy(),
      baseUrl,
    },
    options,
  );
  return { result, journal };
}

function withSteps(patch: (steps: Capability['steps']) => void): Capability {
  const clone = structuredClone(fixture);
  patch(clone.steps);
  return clone;
}

describe.skipIf(surface === null)('replay against the live target', () => {
  afterAll(async () => {
    await surface?.close();
    server?.close();
  });

  it('happy path: extracts the Savings balance exactly as rendered', async () => {
    const { result, journal } = await run({ memberId: '12345' });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;

    // Verbatim: separators intact, still a string. Never a float.
    expect(result.outputs['savingsBalance']).toBe('8,417.32');

    // One tier per resolved step: type, click, extract.
    expect(result.resolutionTiers).toHaveLength(3);
    expect(result.resolutionTiers.every((t) => t >= 1 && t <= 5)).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);

    const steps = journal.steps();
    expect(steps.map((s) => s.stepId)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(steps.every((s) => s.outcome === 'ok' && s.actor === 'automation')).toBe(true);
    expect(steps.find((s) => s.stepId === 's5')?.resolutionTier).toBe(3);
  }, 30_000);

  it('memberId=99999 is a business outcome, not a failure', async () => {
    const { result, journal } = await run({ memberId: '99999' });

    // This is the test that proves the taxonomy. A run that correctly
    // discovers there is no such member has succeeded at its job.
    expect(result.status).not.toBe('failed');
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;

    expect(result.outcome).toBe('MEMBER_NOT_FOUND');
    expect(result.detail).toMatch(/no member exists/i);

    const last = journal.steps().at(-1);
    expect(last?.outcome).toBe('business_outcome');
    expect(last?.detail).toBe('MEMBER_NOT_FOUND');
  }, 30_000);

  it('memberId=77777 is PERMISSION_DENIED', async () => {
    const { result } = await run({ memberId: '77777' });

    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;
    expect(result.outcome).toBe('PERMISSION_DENIED');
  }, 30_000);

  it('memberId=abc fails validation before any browser action', async () => {
    const { result, journal } = await run({ memberId: 'abc' });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    expect(result.stepId).toBe('preflight');
    expect(result.expected).toMatch(/memberId.*\^\\d\{5\}\$/);
    // The failure describes the shape, not the value.
    expect(result.observed).not.toContain('abc');
    expect(result.observed).toMatch(/string of length 3/);

    expect(journal.steps()).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
  });

  it('rejects an undeclared input rather than silently ignoring it', async () => {
    const { result, journal } = await run({ memberId: '12345', accountNumber: '1' });

    expect(result.status).toBe('failed');
    expect(journal.steps()).toHaveLength(0);
  });

  it('?fail=interstitial: dismisses the survey once and still succeeds', async () => {
    const { result, journal } = await run({ memberId: '12345' }, { navigationParams: { fail: 'interstitial' } });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['savingsBalance']).toBe('8,417.32');

    const recoveries = journal.records.filter((r) => r.type === 'event' && r.kind === 'recoverable');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.type === 'event' && recoveries[0].detail).toMatch(/SURVEY_INTERSTITIAL attempt 1\/1/);
  }, 30_000);

  it('?fail=session_expiry: a debuggable hard failure, not a timeout', async () => {
    const started = Date.now();
    const { result } = await run({ memberId: '12345' }, { navigationParams: { fail: 'session_expiry' } });
    const elapsed = Date.now() - started;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    // It fell over at the first step that needed the search form.
    expect(result.stepId).toBe('s2');
    expect(result.expected).toMatch(/Member ID input/);
    // And the report says what was actually there.
    expect(result.observed).toContain('Your session has expired.');
    expect(result.observed).not.toMatch(/timed out/);
    // Well inside the checkpoint timeout: this was recognised, not waited out.
    expect(elapsed).toBeLessThan(fixture.checkpoint.timeoutMs);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatch(/failure-s2\.jpg$/);
  }, 30_000);

  it('?fail=slow_load: the wait strategy absorbs it', async () => {
    const { result } = await run({ memberId: '12345' }, { navigationParams: { fail: 'slow_load' } });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['savingsBalance']).toBe('8,417.32');
  }, 90_000);

  it('refuses a draft capability without allowDraft', async () => {
    const draft: Capability = { ...structuredClone(fixture), approval: 'draft' };

    const refused = await run({ memberId: '12345' }, {}, draft);
    expect(refused.result.status).toBe('failed');
    if (refused.result.status !== 'failed') return;
    expect(refused.result.stepId).toBe('preflight');
    expect(refused.result.expected).toMatch(/approved capability/);
    expect(refused.journal.steps()).toHaveLength(0);

    const allowed = await run({ memberId: '12345' }, { allowDraft: true }, draft);
    expect(allowed.result.status).toBe('success');
  }, 30_000);

  it('a broken locator bundle fails with the full attempted list', async () => {
    const broken = withSteps((steps) => {
      const s2 = steps[1];
      if (!s2 || s2.action !== 'type') throw new Error('fixture shape changed');
      s2.target = {
        frame: ['content'],
        description: 'the Member ID input (deliberately wrong candidates)',
        candidates: [
          { by: 'role', tier: 1, role: 'textbox', name: 'Routing Number' },
          { by: 'label', tier: 2, label: 'Routing Number' },
          { by: 'structural', tier: 4, path: 'input[name="routing"]' },
        ],
      };
    });

    const { result } = await run({ memberId: '12345' }, {}, broken);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.stepId).toBe('s2');
    expect(result.observed).toMatch(/tried 3 strategies/);
    expect(result.observed).toMatch(/tier 1 role \(no match\)/);
    expect(result.observed).toMatch(/tier 2 label \(no match\)/);
    expect(result.observed).toMatch(/tier 4 structural \(no match\)/);
  }, 30_000);

  it('escalates a confirm-risk step without a confirmation token, with evidence', async () => {
    const guarded = withSteps((steps) => {
      const s3 = steps[2];
      if (!s3) throw new Error('fixture shape changed');
      s3.risk = 'confirm';
    });

    const halted = await run({ memberId: '12345' }, {}, guarded);
    expect(halted.result.status).toBe('failed');
    if (halted.result.status !== 'failed') return;
    expect(halted.result.stepId).toBe('s3');
    expect(halted.result.expected).toMatch(/confirmation token/);
    expect(halted.result.evidence[0]).toMatch(/escalation-s3\.jpg$/);

    const s3Row = halted.journal.steps().find((s) => s.stepId === 's3');
    expect(s3Row?.outcome).toBe('stuck');
    // The confirm step never ran: s2 typed, s3 halted, nothing after.
    expect(halted.journal.steps().map((s) => s.stepId)).toEqual(['s1', 's2', 's3']);

    const confirmed = await run({ memberId: '12345' }, { confirmationToken: 'op-7f3a' }, guarded);
    expect(confirmed.result.status).toBe('success');
  }, 30_000);

  it('writes evidence under the run id with no input values in filenames', async () => {
    const { result } = await run({ memberId: '12345' }, { navigationParams: { fail: 'session_expiry' } });
    if (result.status !== 'failed') throw new Error('expected a failure to produce evidence');

    const files = await readdir(path.join(evidenceDir, result.runId));
    expect(files.some((f) => f.endsWith('.jpg'))).toBe(true);
    expect(files.every((f) => !f.includes('12345'))).toBe(true);
  }, 30_000);
});
