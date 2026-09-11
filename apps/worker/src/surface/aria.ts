import type { FrameChain, SurfaceNode } from '@pantograph/core';

/**
 * Parses Playwright's aria snapshot text into `SurfaceNode` trees.
 *
 * Why parse text at all: Playwright removed `page.accessibility.snapshot()`
 * and exposes the accessibility tree only as `locator.ariaSnapshot()`, a
 * YAML-like string. CDP's `Accessibility.getFullAXTree` was the alternative,
 * but it does not descend into frames and the target app is a frameset, so it
 * would see two empty iframe nodes and nothing else. The aria snapshot is
 * Chromium's real tree - the same roles and names a screen reader gets - taken
 * per frame, which is exactly what the resolver's role and label tiers key on.
 *
 * The grammar per line is:
 *
 *   <indent>- <role> ["<name>" | /regex/] [ [attrs] ] [: inline]
 *
 * `- text: hello` is the special case for a bare text node. Anything the
 * parser does not understand is skipped rather than thrown, because a prompt
 * with one node missing is far better than a discovery turn that crashes.
 */

const LINE = /^(\s*)- (.*)$/;
const ROLE = /^([A-Za-z]+)/;
const QUOTED_NAME = /^\s*"((?:[^"\\]|\\.)*)"/;
const REGEX_NAME = /^\s*\/(.*?)\/[a-z]*/;
const ATTRS = /^\s*\[([^\]]*)\]/;
const INLINE = /^\s*:\s*(.*)/;

export function parseAriaSnapshot(text: string, frame: FrameChain): SurfaceNode[] {
  const roots: SurfaceNode[] = [];
  const stack: { depth: number; node: SurfaceNode }[] = [];

  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw);
    if (!match) continue;

    const indent = match[1]?.length ?? 0;
    const body = match[2] ?? '';
    if (body.trim().length === 0) continue;

    // Playwright indents nested items by two spaces per level.
    const depth = Math.floor(indent / 2);
    const node = parseEntry(body, frame);

    while (stack.length > 0 && (stack.at(-1)?.depth ?? -1) >= depth) stack.pop();

    const parent = stack.at(-1);
    if (parent) parent.node.children.push(node);
    else roots.push(node);

    stack.push({ depth, node });
  }

  return roots;
}

function parseEntry(body: string, frame: FrameChain): SurfaceNode {
  let rest = body;

  const role = ROLE.exec(rest)?.[1] ?? '';
  rest = rest.slice(role.length);

  let name = '';
  const quoted = QUOTED_NAME.exec(rest);
  if (quoted) {
    name = unescapeQuoted(quoted[1] ?? '');
    rest = rest.slice(quoted[0].length);
  } else {
    // Playwright emits /regex/ names for long text; the pattern source is the
    // closest thing to the visible text we have.
    const regex = REGEX_NAME.exec(rest);
    if (regex) {
      name = regex[1] ?? '';
      rest = rest.slice(regex[0].length);
    }
  }

  let enabled: boolean | undefined;
  const attrs = ATTRS.exec(rest);
  if (attrs) {
    if (/\bdisabled\b/.test(attrs[1] ?? '')) enabled = false;
    rest = rest.slice(attrs[0].length);
  }

  let inline: string | undefined;
  const colon = INLINE.exec(rest);
  if (colon) {
    const value = stripQuotes((colon[1] ?? '').trim());
    if (value.length > 0) inline = value;
  }

  // A bare text node: the content is its name, there is nothing else to it.
  if (role === 'text') {
    return { role: 'text', name: inline ?? '', frame, children: [] };
  }

  return {
    role,
    name,
    ...(inline !== undefined ? { value: inline } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    frame,
    children: [],
  };
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? unescapeQuoted(value.slice(1, -1))
    : value;
}
