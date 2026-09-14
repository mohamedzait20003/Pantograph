import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import type {
  FrameChain,
  LocatorBundle,
  LocatorCandidate,
  Resolution,
  ResolutionAttempt,
} from '@pantograph/core';

/**
 * The locator resolver: walks a bundle's candidates in tier order and returns
 * the first one that matches exactly one element, recording which tier it was.
 *
 * This module takes a Playwright `Page`, and that is fine: it sits *inside* the
 * surface implementation. The replay engine calls `Surface.resolve(bundle)` and
 * never sees this signature - the Playwright type stops here.
 *
 * Three rules govern every tier:
 *
 *   1. Bounded. Each candidate gets its own short budget, not the step's. A
 *      bundle that falls through five tiers should fail in a few seconds, not
 *      a minute.
 *   2. Ambiguity is failure. If a candidate matches more than one element it is
 *      recorded as `ambiguous: N matches` and the next tier is tried. Silently
 *      taking the first match is how automation clicks the wrong button in
 *      production, and the whole point of tiered candidates is that there is a
 *      next thing to try.
 *   3. Side-effect free. Nothing here scrolls, focuses, or hovers. Resolution
 *      runs before the policy gate has approved anything, so it must be
 *      incapable of changing the target system.
 */

export type ResolveOptions = {
  /** Per-candidate budget. Defaults to 1500ms. */
  candidateTimeoutMs?: number;
  /**
   * Coordinates are never attempted unless this is explicitly true. They are
   * the escape hatch for surfaces with no queryable tree at all - a desktop
   * app, a Citrix session - and never an automatic fallback on web, where a
   * blind click at (412, 388) does whatever happens to be under it today.
   */
  allowCoordinates?: boolean;
};

/** What a coordinates candidate resolves to. The surface decides what to do with it. */
export type PointHandle = { kind: 'point'; x: number; y: number };

export const DEFAULT_CANDIDATE_TIMEOUT_MS = 1500;

/**
 * Walks the frame chain from the main frame down by name. A chain is resolved
 * step by step rather than with `page.frame({ name })`, which searches the
 * whole tree and would match a same-named frame nested somewhere else.
 */
export function resolveFrame(page: Page, chain: FrameChain): Frame | null {
  let current: Frame = page.mainFrame();

  for (const name of chain) {
    const child = current.childFrames().find((frame) => frame.name() === name);
    if (!child) return null;
    current = child;
  }

  return current;
}

export async function resolveBundle(
  page: Page,
  bundle: LocatorBundle,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const timeoutMs = options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  const attempted: ResolutionAttempt[] = [];

  const frame = resolveFrame(page, bundle.frame);
  if (!frame) {
    // Tier 0: nothing was tried, because there was nowhere to try it.
    return {
      found: false,
      attempted: [
        {
          tier: 0,
          by: 'frame',
          detail: `frame chain [${bundle.frame.join(' > ')}] not found in page`,
        },
      ],
    };
  }

  for (const [candidateIndex, candidate] of bundle.candidates.entries()) {
    const result = await resolveCandidate(frame, candidate, options, timeoutMs);
    if (result.found) return { ...result, candidateIndex, attempted };
    attempted.push(result.attempt);
  }

  return { found: false, attempted };
}

type CandidateResolution =
  | { found: true; handle: unknown; tier: number }
  | { found: false; attempt: ResolutionAttempt };

async function resolveCandidate(
  frame: Frame,
  candidate: LocatorCandidate,
  options: ResolveOptions,
  timeoutMs: number,
): Promise<CandidateResolution> {
  if (candidate.by === 'coordinates') {
    if (options.allowCoordinates === true) {
      return { found: true, handle: { kind: 'point', x: candidate.x, y: candidate.y }, tier: candidate.tier };
    }
    return {
      found: false,
      attempt: {
        tier: candidate.tier,
        by: candidate.by,
        detail: 'skipped: coordinate targeting requires explicit opt-in',
      },
    };
  }

  let outcome: CandidateOutcome;
  try {
    outcome = await withTimeout(tryCandidate(frame, candidate), timeoutMs);
  } catch (error) {
    outcome = candidateError(error, timeoutMs);
  }

  if (outcome.matches === 1 && outcome.handle !== undefined) {
    return { found: true, handle: outcome.handle, tier: candidate.tier };
  }
  return {
    found: false,
    attempt: {
      tier: candidate.tier,
      by: candidate.by,
      detail: outcome.detail ?? describeMatchCount(outcome.matches),
    },
  };
}

function candidateError(error: unknown, timeoutMs: number): CandidateOutcome {
  if (error instanceof CandidateTimeout) return { matches: 0, detail: `timed out after ${timeoutMs}ms` };
  return { matches: 0, detail: `error: ${error instanceof Error ? error.message : String(error)}` };
}

function describeMatchCount(matches: number): string {
  return matches === 0 ? 'no match' : `ambiguous: ${matches} matches`;
}

type CandidateOutcome = {
  matches: number;
  handle?: Locator | ElementHandle<HTMLElement | SVGElement>;
  detail?: string;
};

async function tryCandidate(
  frame: Frame,
  candidate: Exclude<LocatorCandidate, { by: 'coordinates' }>,
): Promise<CandidateOutcome> {
  if (candidate.by === 'cell') {
    const cells = await findCells(frame, candidate.row, candidate.column);
    const first = cells[0];
    if (cells.length === 1 && first !== undefined) return { matches: 1, handle: first };
    return { matches: cells.length };
  }

  const locator = buildLocator(frame, candidate);
  // `count()` does not wait and does not touch the page: it is the one
  // Playwright call that satisfies "side-effect free" without qualification.
  const matches = await locator.count();
  return matches === 1 ? { matches, handle: locator } : { matches };
}

type RoleName = Parameters<Frame['getByRole']>[0];

function buildLocator(
  frame: Frame,
  candidate: Exclude<LocatorCandidate, { by: 'coordinates' | 'cell' }>,
): Locator {
  switch (candidate.by) {
    case 'role':
      // Tier 1. Works on the target precisely because the markup has real
      // buttons and bound labels underneath the table soup: the accessible
      // name survives every reskin that keeps the app usable.
      return frame.getByRole(candidate.role as RoleName, { name: candidate.name, exact: false });

    case 'label':
      return frame.getByLabel(candidate.label, { exact: false });

    case 'text':
      return frame.getByText(candidate.text, { exact: candidate.exact ?? false });

    case 'structural':
      // Tier 4. Scoped to the frame, so a path can never escape into a sibling
      // frame that happens to share structure.
      return frame.locator(candidate.path);
  }
}

/**
 * Tier 3 `cell`: the intersection of a row header and a column header.
 *
 * This is the strategy that makes "read the Savings balance" resolvable when
 * every cell in the grid is a number and nothing has a stable identifier. It is
 * also the one most likely to survive a tenant reskin, because the header text
 * is what users read - a vendor can rename every class and renest every table
 * without changing the words "Savings" and "Balance".
 *
 * Done in the page via `HTMLTableElement.rows` and `HTMLTableRowElement.cells`
 * rather than with `tr`/`td` locators, because those DOM collections belong to
 * *this* table only. A CSS descendant query on a layout table would also match
 * the rows of the data table nested inside it, and the indices would be off.
 *
 * One round trip for the whole frame. A first version evaluated per table,
 * which on a page with five layout tables cost fifteen instrumented round
 * trips and blew the candidate budget whenever tracing was on - reporting a
 * tier 4 resolution, and therefore drift, that was not real.
 */
async function findCells(
  frame: Frame,
  row: string,
  column: string,
): Promise<ElementHandle<HTMLElement | SVGElement>[]> {
  const matches = await frame.evaluateHandle(locateCellsInFrame, { row, column });
  const hits: ElementHandle<HTMLElement | SVGElement>[] = [];

  try {
    for (const value of (await matches.getProperties()).values()) {
      const element = value.asElement();
      if (element) hits.push(element);
      else await value.dispose();
    }
  } finally {
    await matches.dispose();
  }

  return hits;
}

/**
 * Runs inside the browser. Playwright serializes this function's source with
 * `toString()` and evals it in the page, so it must be self-contained: no
 * closures over module scope, and - less obviously - NO INNER NAMED FUNCTIONS.
 *
 * tsx compiles with esbuild's `keepNames`, which rewrites `const f = () => ..`
 * into `const f = __name(() => .., "f")`. The `__name` helper exists in the
 * Node bundle and not in the page, so a `normalize` helper here threw
 * `ReferenceError: __name is not defined` in production while every Vitest
 * run (a different esbuild config) passed. The normalization is therefore
 * inlined. A callback passed directly as an argument is safe; only functions
 * that would get an inferred name are wrapped.
 */
function locateCellsInFrame(args: { row: string; column: string }): Element[] {
  const wantRow = args.row.replace(/\s+/g, ' ').trim().toLowerCase();
  const wantColumn = args.column.replace(/\s+/g, ' ').trim().toLowerCase();
  const found: Element[] = [];

  for (const table of Array.from(document.querySelectorAll('table'))) {
    const rows = Array.from(table.rows);
    const header = rows
      .map((row, index) => ({ row, index }))
      .find(({ row }) =>
        Array.from(row.cells).some(
          (cell) =>
            cell.tagName === 'TH' &&
            (cell.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === wantColumn,
        ),
      );
    if (!header) continue;

    const columnIndex = Array.from(header.row.cells).findIndex(
      (cell) =>
        cell.tagName === 'TH' &&
        (cell.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === wantColumn,
    );
    if (columnIndex === -1) continue;

    // Every other row whose first cell is the row header we want. Prefer
    // <th scope="row">, accept a plain first cell; report all so the caller
    // can treat more than one as ambiguous rather than picking.
    const targets = rows
      .filter(
        (row, index) =>
          index !== header.index &&
          (row.cells[0]?.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === wantRow,
      )
      .map((row) => row.cells[columnIndex])
      .filter((target): target is HTMLTableCellElement => target !== undefined);
    found.push(...targets);
  }

  return found;
}

class CandidateTimeout extends Error {
  constructor() {
    super('candidate timed out');
    this.name = 'CandidateTimeout';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CandidateTimeout()), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
