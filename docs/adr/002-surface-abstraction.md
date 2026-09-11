# ADR 002 — The surface abstraction

**Status:** Accepted
**Date:** 2026-09-11

## Context

Pantograph records a flow once and replays it many times, and the recording is
a typed artifact rather than a script. That artifact has to describe two
different things: *what to do* — type here, click this, read that cell — and
*how the surface is perceived and acted upon* to do it. If those are the same
thing, the artifact is a Playwright script with a JSON syntax, and every design
decision in the schema silently assumes a DOM.

That assumption would be wrong for the estate this system exists for. Legacy
banking systems are browser-hosted often enough to start there, but a
meaningful share are Win32 thick clients, Java Swing, terminal emulators, and
Citrix-published applications. None of them has a DOM. All of them have an
accessibility tree of some kind — UIA on Windows, AX on macOS, and screen
regions with OCR on a terminal — and a person operates them by the same
vocabulary: find the control called *Member ID*, put text in it, press the
button called *Search*, read the cell at *Savings* × *Balance*.

So the question this stage answers is where the seam goes. Too high and the
replay engine ends up reasoning about locators, frames and waiting strategies
that only make sense in a browser. Too low and every surface reimplements the
tier ladder, the ambiguity rule, and the side-effect discipline, and they
drift.

## Decision

A `Surface` is the seam, and it lives in `packages/core` with five members:

```
interface Surface {
  capabilities: SurfaceCapabilities
  observe():                     Promise<SurfaceSnapshot>
  resolve(bundle: LocatorBundle): Promise<Resolution>
  act(action: SurfaceAction):    Promise<SurfaceActionResult>
  screenshot():                  Promise<Uint8Array>
  currentLocation():             Promise<string>
}
```

Everything above this line — the artifact schema, the policy gate, the replay
engine, the discovery loop — is written against `Surface` and imports nothing
from any implementation. Everything below it is free to be as browser-specific
as it needs to be.

The test applied to every member was: could a UIA implementation satisfy this
without contortion? Four consequences of that test are visible in the shape.

**The snapshot is an accessibility tree, not a DOM.** `SurfaceSnapshot` is
nodes with `role`, `name`, `value`, `enabled`, a frame chain, and children.
That is the vocabulary every accessibility API already speaks — UIA calls them
ControlType, Name, Value and IsEnabled; AX calls them AXRole, AXTitle, AXValue
and AXEnabled — and it is what the model reads during discovery. It is also
serializable by construction, because it crosses a process boundary to reach
the model and is written to evidence; anything live would not survive the trip.

**Handles are opaque.** `Resolution.handle` is `unknown`. Core never learns
what an element is — a Playwright `Locator` here, an element pointer under
UIA — and the caller's only legal move is to hand it back in a `SurfaceAction`.
This is what stops implementation types leaking upward: the moment core knows
a handle has `.click()`, the schema is browser-shaped.

**`navigate` takes a location string, not a URL.** A desktop surface passes a
window title or a screen identifier and has no URLs at all. The policy engine
still parses the string as a URL *when the surface says it can navigate*, but
the interface does not presume it.

**Capabilities are declared.** `SurfaceCapabilities` says whether the surface
can navigate, screenshot, has frames, or supports coordinate targeting. Replay
checks this before a step runs, so a step that needs something the surface
lacks fails loudly — "this surface cannot navigate" — rather than obscurely,
three layers down, as a null handle. `supportsCoordinates` is how a desktop
surface admits it needs the tier-5 escape hatch, and how the web surface
structurally declines it.

Three things stay in core because they are policy, not perception:

- The **tier ladder itself** — what tier `role` is, that `cell` and `text` are
  equals, that coordinates require approval — is in the `LocatorCandidate`
  schema. An implementation decides *how* to resolve a `cell`; it does not get
  to decide that `cell` is tier 1.
- The **ambiguity rule** — more than one match is a failure, never a coin
  flip — is stated on `Resolution` and tested against the web implementation.
  A UIA implementation that took the first match would be non-conforming.
- The **side-effect discipline** — `resolve` and `observe` must not change the
  screen — is stated on the interface, because resolution runs before the
  policy gate has approved anything.

Three things live only in the implementation:

- How the accessibility tree is obtained. On web it is Chromium's aria
  snapshot, taken per frame and merged, because Playwright removed the
  accessibility API and CDP's tree does not cross frames. Under UIA it would
  be a `TreeWalker` over `RawViewWalker`.
- How a `cell` is found. On web it is `HTMLTableElement.rows` ×
  `HTMLTableRowElement.cells`, computed inside the page. Under UIA it is the
  `GridPattern` / `TablePattern` with `GetItem(row, column)` after resolving
  header indices by name.
- Waiting. The web surface waits for the load event in every frame, because
  the target has no client-side JS. A UIA surface waits for the
  `StructureChanged` and `PropertyChanged` events to quiesce. Neither is a
  fixed sleep, and neither is the caller's concern.

## What a UIA or AX implementation must provide

To satisfy the same interface, a Windows UIA implementation would need:

- `observe()`: walk the automation tree from the target window, mapping
  ControlType → `role` and Name → `name`. The frame chain would carry the
  window or pane hierarchy, since a thick client's "frames" are child windows.
- `resolve()`: tier 1 via `PropertyCondition(ControlType, Name)`; tier 2 via
  `LabeledBy`; tier 3 `cell` via `GridPattern.GetItem` after matching header
  items by name; tier 4 via an automation-id or tree path; tier 5 via a
  bounding-rectangle point, which is where `supportsCoordinates: true` becomes
  honest rather than a liability.
- `act()`: `InvokePattern.Invoke` for click, `ValuePattern.SetValue` for type,
  `SelectionItemPattern.Select` for select, `TextPattern` or `Name` for
  readText. `navigate` would bring a named window to the foreground.
- `screenshot()`: a window capture via `PrintWindow` or the DWM thumbnail API,
  encoded to JPEG.
- `currentLocation()`: the foreground window's title or automation id.

A macOS AX implementation maps identically: `AXRole`/`AXTitle` for the tree,
`AXPress` for click, `AXValue` for type and readText, `AXRows`/`AXColumns` for
cells. Nothing in `core` changes for either.

## Consequences

**What this buys us.** The artifact schema is provably not Playwright-shaped:
the type-checker enforces that `core` imports nothing from the worker, and the
worker's Playwright types stop at `resolveBundle(page, ...)`, one call below
the `Surface` boundary. A recorded capability is a description of intent
against an accessibility tree, and the same JSON could drive a UIA surface
once one exists. The discovery model reads `toPromptText(snapshot)`, which
looks the same for a browser and a thick client, so prompts and tools do not
fork per surface.

Tier telemetry, the ambiguity rule and the side-effect discipline are enforced
once, at the seam, and inherited by every implementation. A new surface cannot
quietly relax them.

**What it costs.** There is one deliberate hole: `PlaywrightWebSurface.pageForHandoff()`
exposes the underlying `Page`, because handing a live session to a human
genuinely requires attaching an operator's input stream to that exact window.
It is named, narrow, and the replay engine must never call it. That "must
never" is enforced by review, not by the compiler, and it is the one place the
abstraction could be eroded by someone in a hurry.

The snapshot parser is text-based. Playwright's aria snapshot format is stable
but not a public contract, so a future Playwright release could change it and
the parser would degrade to skipping nodes it no longer understands. That is
the trade for using Chromium's real accessibility tree rather than
hand-computing accessible names from the DOM, which is a much larger surface
for subtle error.

`readText` returning a value means `act()` cannot return `void`. The
alternative — a separate `read()` method — would have split the one
chokepoint the policy gate and the journal wrap into two. Every action, reads
included, still passes through the same door.

Finally, the abstraction is only as honest as its second implementation.
Until a UIA or AX surface exists, "could satisfy it without contortion" is an
argument rather than a demonstration. The interface was designed against that
implementation on paper; building it is what would prove the seam is in the
right place.
