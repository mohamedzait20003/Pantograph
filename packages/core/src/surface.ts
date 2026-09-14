import { z } from 'zod';
import type { FrameChain, LocatorBundle } from './locator.js';

export const SurfaceNodeSchema: z.ZodType<SurfaceNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string(),
    value: z.string().optional(),
    enabled: z.boolean().optional(),
    frame: z.array(z.string()),
    children: z.array(SurfaceNodeSchema),
  }),
);

export type SurfaceNode = {
  role: string;
  name: string;
  value?: string | undefined;
  enabled?: boolean | undefined;
  frame: FrameChain;
  children: SurfaceNode[];
};

/**
 * A serializable snapshot of what is currently on screen.
 *
 * Serializable is a hard requirement, not a convenience: this crosses a process
 * boundary to reach the model, gets written to evidence, and is replayed in a
 * review UI later. Anything live - a handle, a element reference, a callback -
 * would not survive that trip.
 */
export const SurfaceSnapshotSchema = z.object({
  location: z.string(),
  title: z.string(),
  roots: z.array(SurfaceNodeSchema),
});

export type SurfaceSnapshot = {
  location: string;
  title: string;
  roots: SurfaceNode[];
};

type PromptWalkState = {
  lines: string[];
  lastFrame: string | null;
};

function walkPromptNode(node: SurfaceNode, depth: number, state: PromptWalkState): void {
  const informative = node.role.length > 0 || node.name.length > 0;
  let nextDepth = depth;

  if (informative) {
    const frameKey = node.frame.join('/');

    if (frameKey !== state.lastFrame) {
      state.lines.push(frameKey.length > 0 ? `[frame ${frameKey}]` : '[frame top]');
      state.lastFrame = frameKey;
    }

    const parts: string[] = [node.role.length > 0 ? node.role : 'node'];

    if (node.name.length > 0) parts.push(JSON.stringify(node.name));
    if (node.value !== undefined && node.value.length > 0) {
      parts.push(`= ${JSON.stringify(node.value)}`);
    }
    if (node.enabled === false) parts.push('(disabled)');

    state.lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    nextDepth = depth + 1;
  }

  for (const child of node.children) walkPromptNode(child, nextDepth, state);
}

/**
 * What an implementation can actually do.
 *
 * Replay consults this so a step that needs something the surface lacks fails
 * loudly and specifically - "this surface cannot navigate" - instead of
 * obscurely, three layers down, as a null handle or a timeout.
 */
export type SurfaceCapabilities = {
  canNavigate: boolean;
  canScreenshot: boolean;
  hasFrames: boolean;
  supportsCoordinates: boolean;
};

/** One candidate that was tried and did not produce a unique match. */
export type ResolutionAttempt = {
  tier: number;
  by: string;
  detail: string;
};

/**
 * The outcome of resolving a locator bundle.
 *
 * `handle` is `unknown` on purpose. Core must never know what an element is -
 * for Playwright it is a Locator, for UIA it would be an element pointer - and
 * making it opaque is what stops implementation types leaking upward. The
 * caller's only legal move is to hand it back in a `SurfaceAction`.
 *
 * `tier` is recorded as drift telemetry: a step that resolved at tier 1 when
 * recorded and now resolves at tier 4 still works, but it is telling us the
 * anchor moved. See docs/adr/001-locator-bundles.md.
 */
export type Resolution =
  | {
      found: true;
      handle: unknown;
      tier: number;
      candidateIndex: number;
      /**
       * The higher-tier candidates that missed before this one matched. Empty
       * when the first candidate hit. This is the other half of drift
       * telemetry: "resolved at tier 4" is a symptom, "tier 1 found no match
       * for name 'Member ID'" is the diagnosis.
       */
      attempted: ResolutionAttempt[];
    }
  | { found: false; attempted: ResolutionAttempt[] };

/**
 * `navigate` carries a location string rather than a URL, because a desktop
 * surface would pass a window title or screen identifier and has no URLs at all.
 */
export type SurfaceAction =
  | { kind: 'click'; handle: unknown }
  | { kind: 'type'; handle: unknown; text: string }
  | { kind: 'select'; handle: unknown; value: string }
  | { kind: 'navigate'; location: string }
  | { kind: 'readText'; handle: unknown };

/**
 * `readText` has to return something, so `act` cannot return `void`. Keeping
 * every action on one method - rather than splitting reads onto their own -
 * means the policy gate and the journal wrap a single chokepoint.
 */
export type SurfaceActionResult = {
  text?: string | undefined;
};

export interface Surface {
  readonly capabilities: SurfaceCapabilities;

  observe(): Promise<SurfaceSnapshot>;

  resolve(bundle: LocatorBundle): Promise<Resolution>;

  act(action: SurfaceAction): Promise<SurfaceActionResult>;

  screenshot(): Promise<Uint8Array>;

  currentLocation(): Promise<string>;
}

/**
 * Flattens a snapshot into indented text for a model prompt.
 *
 * Token-frugal by design: this goes into every discovery turn, so its size is a
 * direct and recurring cost. Nodes with neither a role nor a name carry no
 * information a model can act on and are skipped - but their children are still
 * walked, because a meaningless wrapper often contains the button we need.
 * That is the common case on the target app, where layout tables nest several
 * deep around real controls.
 */
export function toPromptText(snapshot: SurfaceSnapshot): string {
  const lines: string[] = [`location: ${snapshot.location}`, `title: ${snapshot.title}`];

  const state: PromptWalkState = { lines, lastFrame: null };

  for (const root of snapshot.roots)
    walkPromptNode(root, 0, state);

  return lines.join('\n');
}
