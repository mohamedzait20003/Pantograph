import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext, type Frame, type Page } from 'playwright';
import type {
  FrameChain,
  LocatorBundle,
  Resolution,
  Surface,
  SurfaceAction,
  SurfaceActionResult,
  SurfaceCapabilities,
  SurfaceNode,
  SurfaceSnapshot,
} from '@pantograph/core';

import { parseAriaSnapshot } from './aria.js';
import { resolveBundle, type PointHandle } from './resolve.js';
import { armSettle, waitForStable } from './wait.js';

/**
 * The web implementation of `Surface`, on Playwright and Chromium.
 *
 * Headed by default. That is not a debugging convenience: the human handoff
 * requires a real, visible window a person can take over and hand back, and
 * that window has to be the same one the replay was driving. `PANTOGRAPH_HEADLESS=1`
 * is the escape for CI, where there is nobody to hand off to.
 *
 * The context is a persistent one (a real profile directory) rather than an
 * incognito context, for the same reason: a session an operator authenticated
 * by hand has to survive for the automation that resumes after them.
 */

export type LaunchOptions = {
  /** Resolves relative `navigate` locations. */
  baseUrl: string;
  /** Overrides the env default. */
  headless?: boolean;
  /** Profile directory. A fresh temp dir if omitted. */
  userDataDir?: string;
  /** Budget for a single action and for the settle that follows it. */
  actionTimeoutMs?: number;
};

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** Shape shared by Locator and ElementHandle - the only surface `act` needs. */
type Actionable = {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(value: string, options?: { timeout?: number }): Promise<string[]>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
};

export class PlaywrightWebSurface implements Surface {
  /**
   * `supportsCoordinates` is false, and that is structural rather than a
   * setting. A web surface always has a queryable tree, so a coordinate click
   * is never the right answer here - the resolver is invoked without the
   * opt-in, and `act` refuses a point handle outright.
   */
  readonly capabilities: SurfaceCapabilities = {
    canNavigate: true,
    canScreenshot: true,
    hasFrames: true,
    supportsCoordinates: false,
  };

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly actionTimeoutMs: number,
  ) {}

  static async launch(options: LaunchOptions): Promise<PlaywrightWebSurface> {
    const headless = options.headless ?? envHeadless();
    const userDataDir =
      options.userDataDir ?? (await mkdtemp(path.join(tmpdir(), 'pantograph-profile-')));

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 900 },
    });

    const page = context.pages()[0] ?? (await context.newPage());

    return new PlaywrightWebSurface(
      context,
      page,
      options.baseUrl,
      options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    );
  }

  /**
   * One snapshot across every frame. Frame traversal is not optional: the
   * target is a frameset, and so is most of the legacy estate. A snapshot of
   * the top-level document alone would show two empty iframe nodes.
   */
  async observe(): Promise<SurfaceSnapshot> {
    const roots: SurfaceNode[] = [];

    for (const frame of this.page.frames()) {
      let text: string;
      try {
        text = await frame.locator(':root').ariaSnapshot({ timeout: 2_000 });
      } catch {
        // A frame mid-navigation or already detached has nothing to report.
        continue;
      }
      roots.push(...parseAriaSnapshot(text, frameChainOf(frame)));
    }

    return { location: this.page.url(), title: await this.page.title(), roots };
  }

  async resolve(bundle: LocatorBundle): Promise<Resolution> {
    return resolveBundle(this.page, bundle);
  }

  async act(action: SurfaceAction): Promise<SurfaceActionResult> {
    const timeout = this.actionTimeoutMs;

    switch (action.kind) {
      case 'navigate': {
        const target = new URL(action.location, this.baseUrl).toString();
        await this.page.goto(target, { waitUntil: 'load', timeout });
        await waitForStable(this.page, timeout);
        return {};
      }

      case 'click': {
        // Arm before the click: a form submit navigates immediately and a
        // listener attached afterwards would miss it.
        const settle = armSettle(this.page, { timeoutMs: timeout });
        await this.actionable(action.handle).click({ timeout });
        await settle();
        return {};
      }

      case 'type':
        await this.actionable(action.handle).fill(action.text, { timeout });
        return {};

      case 'select':
        await this.actionable(action.handle).selectOption(action.value, { timeout });
        return {};

      case 'readText': {
        const text = await this.actionable(action.handle).textContent({ timeout });
        return { text: (text ?? '').replace(/\s+/g, ' ').trim() };
      }
    }
  }

  /**
   * JPEG at modest quality on purpose. These stream to the operator console at
   * a couple of frames a second, so bytes on the wire matter far more than
   * pixel fidelity - and PNG would be four to ten times larger for a page
   * that is mostly flat grey table borders.
   */
  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ type: 'jpeg', quality: 50 });
  }

  async currentLocation(): Promise<string> {
    return this.page.url();
  }

  /**
   * The one deliberate hole in the abstraction, for the handoff code only.
   *
   * Handing a live session to a human means attaching an operator's input
   * stream to this exact browser window, and that genuinely requires the
   * Playwright `Page`. The replay engine must never call this: everything it
   * needs is on `Surface`, and the moment it reaches for a `Page` the artifact
   * schema starts growing browser-shaped assumptions. Keeping the accessor
   * named and narrow makes that reach visible in review.
   */
  pageForHandoff(): Page {
    return this.page;
  }

  /**
   * Tracing is surface-specific evidence and lives here, not on `Surface`.
   * The replay engine does not know traces exist; the process that owns the
   * surface starts one before a run and hands the bytes to the evidence
   * store after. A UIA surface would produce an event log the same way.
   */
  async startTracing(): Promise<void> {
    await this.context.tracing.start({ screenshots: true, snapshots: true });
  }

  async stopTracing(): Promise<Uint8Array> {
    const file = path.join(tmpdir(), `pantograph-trace-${process.pid}-${Date.now()}.zip`);
    await this.context.tracing.stop({ path: file });
    try {
      return await readFile(file);
    } finally {
      await rm(file, { force: true });
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  private actionable(handle: unknown): Actionable {
    if (isPointHandle(handle)) {
      throw new Error(
        'This surface does not support coordinate actions; supportsCoordinates is false.',
      );
    }

    if (
      typeof handle === 'object' &&
      handle !== null &&
      'click' in handle &&
      'fill' in handle &&
      'textContent' in handle
    ) {
      return handle as Actionable;
    }

    throw new Error('Handle did not come from this surface; resolve it first.');
  }
}

function envHeadless(): boolean {
  const raw = process.env.PANTOGRAPH_HEADLESS;
  return raw === '1' || raw === 'true';
}

/** Names from the main frame down to this one; empty for the main frame. */
function frameChainOf(frame: Frame): FrameChain {
  const chain: string[] = [];
  let current: Frame | null = frame;

  while (current !== null && current.parentFrame() !== null) {
    chain.unshift(current.name());
    current = current.parentFrame();
  }

  return chain;
}

function isPointHandle(handle: unknown): handle is PointHandle {
  return (
    typeof handle === 'object' &&
    handle !== null &&
    (handle as { kind?: unknown }).kind === 'point'
  );
}
