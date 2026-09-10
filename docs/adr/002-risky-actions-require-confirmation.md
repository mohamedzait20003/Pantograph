# ADR 002 — Irreversible actions require confirmation, not prohibition

**Status:** Accepted
**Date:** 2026-09-09

## Context

Pantograph drives a live bank servicing system. Some of what it does is
reversible and cheap — looking up a member, reading a balance, navigating
between screens. Some of it is neither: opening a sub-account submits a form
that creates a real record with a real reference number, and there is no undo
button on the other side.

The system also has a property that makes this sharper than usual: at replay
time there is no model in the decision loop. A recorded artifact executes
deterministically. Whatever the artifact says to do, it does, at whatever hour
the scheduler fires it, with nobody watching. So the question "what is this
allowed to do unattended?" has to be answered in the artifact and the policy
engine, not by an operator's judgement in the moment.

There are three possible answers for an irreversible step.

**Allow it.** Fastest, and wrong. An automation that can open accounts
unattended, driven by an artifact that a model wrote, is exactly the failure
mode that makes this category of tool unshippable in a regulated environment.
The first time a locator drifts and a click lands on the wrong button, the
system has done something to a customer's account that nobody authorised and
nobody noticed.

**Block it.** Safe, and useless. `/member/:id/subaccount` is not an edge case we
tolerate — opening a sub-account is *the work*. A bank agent that can read
balances but cannot complete any servicing task has automated the cheap half of
the job and left the expensive half untouched. Blocking every write reduces the
product to a screen scraper, and the sub-account flow — the one capability that
demonstrates the whole premise — becomes impossible to express.

**Gate it behind a human.** This preserves the capability while moving
accountability for the irreversible part to a person.

## Decision

Every step carries a `RiskClass` of `safe`, `confirm`, or `blocked`, and the
policy engine classifies conservatively:

- `safe` — `navigate`, `extract`, `assert`. Reads and movement. They change no
  state and leave nothing behind.
- `confirm` — `click`, `type`, `select`. Anything that can reach a form is
  presumed to write. Replay pauses and a human approves before it executes.
- `blocked` — nothing by default. Reserved for an operator deny list and for
  steps a reviewer has explicitly disarmed.

Three supporting choices make this work rather than merely sound good:

**Unrecognized actions classify as `confirm`, not `safe`.** An action name this
build has never seen — an artifact from a newer schema, a step type added by a
desktop implementation — is precisely the case where we cannot reason about
blast radius. Failing open would mean that the way to get an unreviewed mutation
executed unattended is to emit an action name we do not know. The cost of being
wrong in the safe direction is a human approving something harmless.

**`confirm` carries a reason.** `explainRisk` returns the evidence alongside the
class — "the target control is inside a form that POSTs", "'Submit Application'
names a state-changing action". An operator asked to approve an irreversible
action needs to know *why* they are being asked. A confirmation dialog with no
argument in it gets clicked through, and then the gate has cost us latency
without buying us safety.

**Blocking still exists, as an operator control rather than a default.** The
deny list outranks the artifact, and it is checked before anything else. This is
the kill switch for one step of an otherwise useful capability, without deleting
the recording or re-running discovery.

The classifier is not the last word. A recorded artifact carries a *reviewed*
`risk` per step, set by a human reading the flow in a pull request, and at
replay time that reviewed value governs — clicking `Search` submits a form but
changes nothing, and a reviewer can say so. The one thing review cannot do is
downgrade a `blocked`.

## Consequences

**What this buys us.** The sub-account flow is expressible, recordable, and
replayable — the capability survives. The irreversible step has a named human
attached to it, and because the approval lands in the `interventions` table and
the approving actor lands in the `steps` journal, "who authorised this account
to be opened" has an answer after the fact. Read-only capabilities, which are
the majority, still run fully unattended: gating writes does not tax reads.

**What it costs.** A capability containing a `confirm` step cannot complete
without a person, so throughput on write flows is bounded by operator
availability, and a queued run can sit waiting for hours. That is a real
limitation and we are choosing it deliberately over the alternative.

The serious risk is habituation. A human who approves forty sub-account openings
an hour is not meaningfully reviewing the fortieth, and at that point the gate is
theatre that also slows us down. The reason strings help, but they do not solve
it. If write volume ever reaches that level, the honest answer is a different
mechanism — batch approval with sampled review, or per-capability standing
authorisation with tighter policy bounds — not a confirmation dialog that
everyone has learned to dismiss. We should watch approval latency and approval
rate: an approval rate of essentially 100% is evidence the gate has stopped
doing work.

There is also a scope limit worth stating plainly. Confirmation gates the
*decision to act*. It does not make the action atomic. If a worker dies after
submitting the form but before recording the result, the side effect has
happened and the record has not — which is why `reapStaleRuns` marks a lost
session `failed` and never re-queues it. Confirmation and non-retry are two
halves of the same position: a mutation on a bank system happens at most once,
and a human decides both times it matters.
