# ADR 001 — A locator is an ordered bundle of tiered strategies, not a selector

**Status:** Accepted
**Date:** 2026-09-09

## Context

Pantograph records a discovery run against a legacy banking UI and replays it
deterministically, with no model in the decision loop. Every step in a recorded
artifact has to name an element on a page, and the way we name it is the single
biggest determinant of how long an artifact stays useful.

The surface makes the usual approach untenable. The target system is a frameset
shell with table-based layout, class names like `c1` and `r2`, no test ids, and
no client-side JavaScript. A CSS selector against it encodes nothing about
intent — `table tr:nth-child(3) td:nth-child(3)` means "the third cell of the
third row", which stops being the Savings balance the moment an account is
opened, a column is added, or the vendor ships a point release that wraps the
grid in another `<td>`. We cannot ask for test ids: we do not own the
application, and the premise of the project is that these systems have no API
and no cooperative vendor.

What the surface *does* have is a clean accessibility tree. Inputs have bound
`<label for>`, actions are real `<button>` elements with visible text, and data
tables carry `<th scope="row">`. So there is a stable naming layer available —
but it is not uniformly available. Some elements have an accessible role and
name; some are only reachable as a table cell at the intersection of two
headers; a few have nothing but position.

That leaves a real design question. A single strategy is either too weak to
cover every element or too brittle to survive. And there is a second problem
underneath the first: even a locator that keeps working can be *drifting*. If
the accessible name of the Member ID field changes, a fallback may quietly
absorb the change and the artifact keeps passing — right up until the fallback
breaks too, at which point the failure arrives with no warning and no history.

## Decision

A locator is an ordered bundle:

```
LocatorBundle {
  frame: FrameChain            // e.g. ['content']
  candidates: LocatorCandidate[]  // non-empty, sorted by ascending tier
  description: string          // "the Member ID input on the search form"
}
```

Each candidate declares a strategy and an explicit **tier**, pinned to the
strategy by a literal type so an artifact cannot claim a coordinate click is a
tier 1 locator:

| Tier | Strategy      | Anchored on                          |
| ---- | ------------- | ------------------------------------ |
| 1    | `role`        | accessible role + accessible name    |
| 2    | `label`       | bound `<label for>` text             |
| 3    | `cell`        | row header × column header           |
| 3    | `text`        | visible text content                 |
| 4    | `structural`  | a scoped path within the frame       |
| 5    | `coordinates` | an x/y point — gated, never automatic |

Replay tries candidates in array order and **records which tier actually
matched**. That resolution tier is returned on every successful run as
`resolutionTiers: number[]`.

Three supporting choices:

- **Sorted order is validated, not conventional.** Replay executes candidates in
  array order, so an out-of-order bundle would silently prefer a weaker
  strategy. The schema rejects it rather than trusting the recorder.
- **`description` is required.** The bundle is a reviewed object in a pull
  request. A human reading a diff needs to know a step targets "the Balance cell
  of the Savings row" without decoding three strategies to work it out.
- **`coordinates` carries `requiresApproval: true` as a literal.** It exists for
  surfaces with no queryable tree at all — a Win32 desktop client, a Citrix
  session, a canvas renderer — because the schema must not assume the DOM. It is
  never selected automatically on web, and it is not a flag the recorder can
  turn off.

## Consequences

**What this buys us.**

Artifacts survive cosmetic change. A vendor point release that renests the
layout tables breaks every `structural` path and no `role` locator. Coverage is
complete without being uniformly brittle: elements with a clean accessible name
get tier 1, table cells that have no name of their own get tier 3 via their row
and column headers, and the long tail still has a last resort instead of an
unrecordable step.

More importantly, **the recorded tier turns drift into telemetry**. A step that
resolved at tier 1 when recorded and now resolves at tier 4 is still passing —
but the accessible name it was anchored to is gone. That is a signal we can
alert on, weeks before the tier 4 fallback breaks and takes the capability down
with no notice. Comparing recorded tiers against replay tiers converts a class
of silent decay into a dashboard, and it gives an on-call engineer a specific,
actionable diff rather than "the automation broke".

This also underpins the multi-tenant story. When a capability recorded against
tenant A runs against tenant B, a tier drop is the mechanical signature of a
variant difference — tenant B calls the field "Account Number", so the tier 1
and tier 2 candidates miss and a weaker one catches. That tells us precisely
which step needs a per-variant override, instead of requiring the whole flow to
be re-recorded.

**What it costs.**

Recording is more expensive: the discovery agent has to synthesise several
strategies per element rather than grab one selector, and it has to get the
tiers right. Artifacts are correspondingly more verbose — a single click step is
a dozen lines of JSON, which is a real cost to human review even with
`description` carrying the intent.

There is a genuine hazard in fallbacks: a lower-tier candidate can match the
*wrong* element and let a run continue with a plausible wrong answer. Two things
contain it — the per-step `checkpoint`, which asserts the flow reached the state
we expect rather than assuming a click worked, and tier telemetry, which makes
the degradation visible instead of silent. Neither eliminates the risk. A
capability that has quietly fallen to tier 4 across the board should be
re-recorded, and we should treat a sustained tier drop as an alert rather than a
curiosity.

Finally, the tier ladder is a judgement, not a measurement. Ranking `cell` and
`text` as equals, or `label` below `role`, reflects what we expect to be stable
on this class of application. If replay telemetry later shows `label` outliving
`role` in practice, the ordering should change — and because the tier is part of
the schema rather than an implementation detail, changing it is a visible,
reviewable event.
