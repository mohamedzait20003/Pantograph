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
    if (candidate.by === 'coordinates') {
      if (options.allowCoordinates !== true) {
        attempted.push({
          tier: candidate.tier,
          by: candidate.by,
          detail: 'skipped: coordinate targeting requires explicit opt-in',
        });
        continue;
      }

      const handle: PointHandle = { kind: 'point', x: candidate.x, y: candidate.y };
      return { found: true, handle, tier: candidate.tier, candidateIndex };
    }

    let outcome: CandidateOutcome;
    try {
      outcome = await withTimeout(tryCandidate(frame, candidate), timeoutMs);
    } catch (error) {
      outcome = {
        matches: 0,
        detail:
          error instanceof CandidateTimeout
            ? `timed out after ${timeoutMs}ms`
            : `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (outcome.matches === 1 && outcome.handle !== undefined) {
      return { found: true, handle: outcome.handle, tier: candidate.tier, candidateIndex };
    }

    attempted.push({
      tier: candidate.tier,
      by: candidate.by,
      detail:
        outcome.detail ??
        (outcome.matches === 0 ? 'no match' : `ambiguous: ${outcome.matches} matches`),
    });
  }

  return { found: false, attempted };
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
    return cells.length === 1 && first !== undefined
      ? { matches: 1, handle: first }
      : { matches: cells.length };
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
 */
async function findCells(
  frame: Frame,
  row: string,
  column: string,
): Promise<ElementHandle<HTMLElement | SVGElement>[]> {
  const tables = frame.locator('table');
  const total = await tables.count();
  const hits: ElementHandle<HTMLElement | SVGElement>[] = [];

  for (let index = 0; index < total; index += 1) {
    const matches = await tables.nth(index).evaluateHandle(locateCellsInTable, { row, column });

    for (const value of (await matches.getProperties()).values()) {
      const element = value.asElement();
      if (element) hits.push(element);
      else await value.dispose();
    }
    await matches.dispose();
  }

  return hits;
}

/**
 * Runs inside the browser. Must be self-contained: no closures over module
 * scope, because Playwright serializes the function source and ships it over.
 */
function locateCellsInTable(
  table: HTMLElement | SVGElement,
  args: { row: string; column: string },
): Element[] {
  if (!(table instanceof HTMLTableElement)) return [];

  const normalize = (text: string | null): string =>
    (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  const wantRow = normalize(args.row);
  const wantColumn = normalize(args.column);
  const rows = Array.from(table.rows);

  // The column index comes from the first row that has a matching <th>.
  let columnIndex = -1;
  let headerRowIndex = -1;
  for (let r = 0; r < rows.length; r += 1) {
    const cells = Array.from(rows[r]?.cells ?? []);
    const found = cells.findIndex(
      (cell) => cell.tagName === 'TH' && normalize(cell.textContent) === wantColumn,
    );
    if (found !== -1) {
      columnIndex = found;
      headerRowIndex = r;
      break;
    }
  }
  if (columnIndex === -1) return [];

  // Every other row whose first cell is the row header we want. Prefer
  // <th scope="row">, accept a plain first cell; report all so the caller can
  // treat more than one as ambiguous rather than picking.
  const found: Element[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    if (r === headerRowIndex) continue;
    const cells = Array.from(rows[r]?.cells ?? []);
    const first = cells[0];
    if (!first || normalize(first.textContent) !== wantRow) continue;

    const target = cells[columnIndex];
    if (target) found.push(target);
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
