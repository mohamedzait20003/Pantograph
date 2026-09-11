import type { Server } from 'node:http';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '@pantograph/target';
import { toPromptText, type LocatorBundle } from '@pantograph/core';

import { PlaywrightWebSurface } from '../src/surface/playwright.js';
import { resolveBundle } from '../src/surface/resolve.js';

/**
 * These run against the real target app, in-process, on an ephemeral port.
 * A resolver test against a mock DOM would prove the mock is resolvable.
 *
 * Both the server and the browser are probed up front so the suite skips with
 * a reason rather than failing on a machine where Chromium is not installed.
 */

let server: Server | null = null;
let surface: PlaywrightWebSurface | null = null;
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
  const baseUrl = `http://localhost:${address.port}`;

  surface = await PlaywrightWebSurface.launch({
    baseUrl,
    // Headed is the production default; a test run should not open windows.
    headless: process.env.PANTOGRAPH_HEADED !== '1',
  });
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error);
  server?.close();
}

if (surface === null) {
  console.warn(
    `[resolve.test] skipped - ${skipReason}.\n` +
      `  Chromium is required: pnpm --filter @pantograph/worker exec playwright install chromium`,
  );
}

function live(): PlaywrightWebSurface {
  if (surface === null) throw new Error('surface unavailable');
  return surface;
}

function bundle(candidates: LocatorBundle['candidates'], frame: string[] = ['content']): LocatorBundle {
  return { frame, candidates, description: 'test bundle' };
}

const searchButton = bundle([{ by: 'role', tier: 1, role: 'button', name: 'Search' }]);
const memberIdInput = bundle([{ by: 'label', tier: 2, label: 'Member ID' }]);

async function openMember(id: string): Promise<void> {
  const s = live();
  const input = await s.resolve(memberIdInput);
  if (!input.found) throw new Error('could not resolve Member ID input');
  await s.act({ kind: 'type', handle: input.handle, text: id });

  const button = await s.resolve(searchButton);
  if (!button.found) throw new Error('could not resolve Search button');
  await s.act({ kind: 'click', handle: button.handle });
}

describe.skipIf(surface === null)('the resolver against the live target', () => {
  beforeEach(async () => {
    await live().act({ kind: 'navigate', location: '/' });
  });

  afterAll(async () => {
    await surface?.close();
    server?.close();
  });

  it('resolves the Search button by role and name at tier 1', async () => {
    const result = await live().resolve(searchButton);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.tier).toBe(1);
    expect(result.candidateIndex).toBe(0);
  });

  it('resolves the Member ID input by its bound label at tier 2', async () => {
    const result = await live().resolve(memberIdInput);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.tier).toBe(2);
  });

  it('resolves the Savings / Balance cell at tier 3 and reads the right value', async () => {
    await openMember('12345');

    const result = await live().resolve(
      bundle([{ by: 'cell', tier: 3, row: 'Savings', column: 'Balance' }]),
    );

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.tier).toBe(3);

    const { text } = await live().act({ kind: 'readText', handle: result.handle });
    expect(text).toBe('8,417.32');
  });

  it('anchors on both headers: a different row or column reads a different cell', async () => {
    await openMember('12345');
    const s = live();

    const checking = await s.resolve(bundle([{ by: 'cell', tier: 3, row: 'Checking', column: 'Balance' }]));
    const savingsNumber = await s.resolve(bundle([{ by: 'cell', tier: 3, row: 'Savings', column: 'Number' }]));

    expect(checking.found && (await s.act({ kind: 'readText', handle: checking.handle })).text).toBe('1,204.55');
    expect(savingsNumber.found && (await s.act({ kind: 'readText', handle: savingsNumber.handle })).text).toBe(
      '0041-887-9',
    );
  });

  it('falls through a wrong tier-1 candidate to tier 2 and reports tier 2', async () => {
    const result = await live().resolve(
      bundle([
        { by: 'role', tier: 1, role: 'textbox', name: 'Account Number' }, // tenant B's label
        { by: 'label', tier: 2, label: 'Member ID' },
      ]),
    );

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.tier).toBe(2);
    expect(result.candidateIndex).toBe(1);
  });

  it('treats an ambiguous match as a failure and falls through', async () => {
    // "Member ID" is the label text and also appears in the hint sentence
    // under the form, so a loose text match hits more than one element.
    const result = await live().resolve(
      bundle([
        { by: 'text', tier: 3, text: 'Member ID' },
        { by: 'structural', tier: 4, path: 'input[name="memberId"]' },
      ]),
    );

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.tier).toBe(4);
    expect(result.candidateIndex).toBe(1);
  });

  it('reports the ambiguity when nothing later in the bundle resolves', async () => {
    const result = await live().resolve(bundle([{ by: 'text', tier: 3, text: 'Member ID' }]));

    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.attempted).toHaveLength(1);
    expect(result.attempted[0]?.detail).toMatch(/^ambiguous: \d+ matches$/);
  });

  it('returns found: false with every attempt listed when nothing matches', async () => {
    const result = await live().resolve(
      bundle([
        { by: 'role', tier: 1, role: 'button', name: 'Approve Transfer' },
        { by: 'label', tier: 2, label: 'Routing Number' },
        { by: 'text', tier: 3, text: 'Wire Transfer' },
        { by: 'structural', tier: 4, path: '#no-such-id' },
      ]),
    );

    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.attempted.map((a) => a.tier)).toEqual([1, 2, 3, 4]);
    expect(result.attempted.every((a) => a.detail === 'no match')).toBe(true);
  });

  it('does not attempt a coordinates candidate without explicit opt-in', async () => {
    const coordinates = bundle([
      { by: 'coordinates', tier: 5, x: 200, y: 120, requiresApproval: true },
    ]);

    const viaSurface = await live().resolve(coordinates);
    expect(viaSurface.found).toBe(false);
    if (viaSurface.found) return;
    expect(viaSurface.attempted[0]?.detail).toMatch(/requires explicit opt-in/);

    // The resolver itself honours an explicit opt-in; the web surface never
    // grants one.
    const optedIn = await resolveBundle(live().pageForHandoff(), coordinates, {
      allowCoordinates: true,
    });
    expect(optedIn.found).toBe(true);
    if (!optedIn.found) return;
    expect(optedIn.tier).toBe(5);
  });

  it('fails clearly when the frame chain does not exist', async () => {
    const result = await live().resolve(bundle([{ by: 'role', tier: 1, role: 'button', name: 'Search' }], ['popup']));

    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.attempted[0]?.by).toBe('frame');
  });

  it('observes the accessibility tree across frames, tagged by frame', async () => {
    const snapshot = await live().observe();
    const text = toPromptText(snapshot);

    expect(text).toContain('[frame content]');
    expect(text).toContain('textbox "Member ID"');
    expect(text).toContain('button "Search"');
    expect(text).toContain('[frame nav]');
    expect(text).toContain('link "Member Search"');

    // Serializable, by construction: the prompt text is derived from data that
    // survives a JSON round trip unchanged.
    expect(toPromptText(JSON.parse(JSON.stringify(snapshot)))).toBe(text);
  });
});
