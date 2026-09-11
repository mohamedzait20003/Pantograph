/**
 * The worker is a library at this stage: the web `Surface` implementation and
 * its resolver. The replay engine and the discovery loop land here next and
 * consume `Surface`, never Playwright directly.
 */

export { PlaywrightWebSurface, type LaunchOptions } from './surface/playwright.js';
export { resolveBundle, resolveFrame, type ResolveOptions, type PointHandle } from './surface/resolve.js';
export { armSettle, waitForStable } from './surface/wait.js';
export { parseAriaSnapshot } from './surface/aria.js';
