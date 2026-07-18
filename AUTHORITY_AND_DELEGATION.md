AUTHORITY_AND_DELEGATION.md
Authority Hierarchy and Delegation Doctrine

Document: /AUTHORITY_AND_DELEGATION.md
Project: Vireon CORE
Status: Draft v2 (Phase 6B hierarchy/standing-authorization + Phase 6D delegation)
Date: 2026-07-18

Doctrine document for the vertical authority hierarchy and standing-authorization
mechanism (Phase 6B), the authority resolution engine's policy (Phase 6C, engine
built in `src/elora/resolveAuthorityWithHierarchy.ts`), and the delegation
mechanism (Phase 6D) reconciling vertical and peer delegation as one primitive.

## 1. Purpose

This document defines the authority hierarchy that governs every persona actor in
Vireon CORE: who reports to whom, how a persona may become pre-authorized to act
without per-instance escalation, and the floor that no standing authorization can
lower.

This is schema and policy doctrine, not runtime behavior. Phase 6B adds the tables
and constraints this document describes. Nothing in the live runtime — including
`classifyAuthority.ts`, `transitionWorkOrder.ts`, and `ingestUserMessage.ts` —
consults any of it yet. The resolution engine that actually walks the hierarchy,
resolves standing rules, and enforces the floor at runtime is Phase 6C, a separate,
later phase.

## 2. The Vertical Reporting Hierarchy

Every hierarchy participant — the human Sovereign and every persona actor — holds
exactly one `hierarchy_tier` and (except the Sovereign) reports to exactly one
superior via `reports_to_actor_id`. The tiers, outermost to innermost:

```
Sovereign (human, tier: sovereign)
  └─ Elora — CEO (tier: executive)
       ├─ 11 Inner Circle Chiefs (tier: inner_circle)
       │     └─ each Chief's Outer Circle Lieutenant (tier: outer_circle)
       └─ 8 Special Envoys (tier: special_envoy)
```

- **Sovereign.** The human root of the hierarchy. Reports to no one
  (`reports_to_actor_id IS NULL`). Exactly one per tenant.
- **Elora (executive).** Reports directly to the Sovereign. The sole executive tier.
- **Inner Circle (11).** The C-suite Chiefs. Each reports directly to Elora.
- **Outer Circle (11).** Each Outer Circle Lieutenant reports to their specific
  Inner Circle Chief, not to Elora directly — this is the one tier with a real
  two-hop chain to Elora.
- **Special Envoys (8).** Report directly to Elora. Several Special Envoys have a
  secondary domain-affinity relationship named in persona lore (e.g. Cipher's
  affinity with Valtrix) — that is not a second hierarchy edge. It is a
  peer-delegation concern, out of scope until Phase 6D.
- **Swarm.** Named in the schema's `hierarchy_tier` vocabulary for completeness.
  No actor holds this tier yet — see §7.

Structural facts about this hierarchy (a tenant has exactly one Sovereign; a
non-Sovereign hierarchy participant must report to someone in the same tenant; a
Sovereign reports to no one) are enforced at the schema layer via CHECK constraints
and a partial unique index. Cycle detection, valid-reporting-path validation, and
any other check that requires walking the hierarchy at runtime are explicitly not
part of this schema layer — that is Phase 6C's responsibility.

## 3. Standing Authorization

By default, every action a persona might take that isn't clearly safe requires
escalation to a human — see §4. A **standing authorization** is how a persona
becomes pre-cleared to act on a specific, narrow, recurring pattern without that
per-instance escalation.

Standing authorizations are `authority_standing_rules` rows, distinguished by a
`polarity` column rather than living in two separate tables:

- **`polarity = 'approve'`** — a positive pre-authorization.
- **`polarity = 'refuse'`** — an auto-refuse mirror: a tightening rule, not a
  loosening one.

**Approval/refusal semantics, stated precisely:**

> Approval-polarity standing rules apply only to eligible `escalate` and
> `act_and_report` patterns. They cannot override `refuse`, `setup_required`, or
> `capability_missing`. Refusal-polarity rules are a separate tightening mechanism
> that may produce `refuse`, but can never loosen an existing refusal or authorize
> an otherwise-blocked action.

A standing rule is always narrow and scoped to a single, non-empty `domain` — there
is no "applies everywhere" rule, by doctrine. Its `match_criteria` is a structured
matching payload whose shape is deliberately undefined at this layer; that
matching-schema decision belongs to Phase 6C's own decisions-first pass.

Every standing rule records who proposed it (`proposed_by_actor_id`, optional) and
who confirmed it (`confirmed_by_actor_id`, required). **`confirmed_by_actor_id`
must always resolve to the Sovereign's actor id** — no one else may confirm a
standing authorization. This is the single most important invariant in the standing
rules table, and Phase 6B does **not** enforce it at the database layer: the
foreign key on `confirmed_by_actor_id` proves the confirmer is a real actor in the
same tenant, not that they are actually the Sovereign. Enforcing the Sovereign-only
invariant is deferred to Phase 6C (or a dedicated follow-up) to decide how to do
properly — for example, a function-based check against `hierarchy_tier` — since
that check is resolution-adjacent logic, not a structural schema fact.

Revocation is tracked with provenance: a revoked rule must record who revoked it
(`revoked_by_actor_id`) and why (`revocation_reason`), and its `revoked_at`
timestamp must be set consistently with its `status`. A rule's revocation fields
are either all null (`status = 'active'`) or all present (`status = 'revoked'`) —
enforced by `chk_asr_revocation_consistency`.

## 4. Default Posture and Category Boundaries

**Default posture: auto-escalate.** Nothing becomes silently resolvable until a
standing authorization has been positively, explicitly established by the
Sovereign. The absence of a rule is not permission — it is a request for a human
decision.

Certain categories are **permanently ineligible for standing pre-authorization**,
regardless of how narrow a proposed rule might be:

- Actions matching an **RMT** (risky/mutating/there's-no-undo pattern).
- **Sensitive-data handling.**
- **Irreversible actions.**

These default to `escalate` and stay there — no standing rule, however specific,
can move them to `act` or `act_and_report`.

`refuse` is reserved specifically for **adversarial extraction intent** — an
attempt to manipulate, jailbreak, or extract behavior the system should not
produce. It is not a general-purpose "no" for merely risky requests; those are
`escalate`'s job.

## 5. The Hybrid Floor

The floor is fixed, universal doctrine — not a revocable per-persona database row,
and Phase 6B does not build a "floor rules" table for it:

- **Adversarial extraction intent → `refuse`, globally**, for every persona, with
  no standing rule able to change this.
- **Irreversible action without an explicit grant → `escalate`, globally**, for
  every persona, with no standing rule able to change this.

The floor's defining property: **a standing authorization can only tighten
behavior, never loosen it below the floor.** A refusal-polarity rule can turn an
`escalate` into a `refuse`. No rule of either polarity can turn a floor-mandated
`refuse` or `escalate` into anything more permissive.

## 6. Delegation — Supervised and Peer

Two mechanisms that were designed separately turn out to share enough structure to
be one shared primitive rather than two separate systems: `docs/architecture/core-runtime.md`
§11's pre-existing "Agent Delegation Model" doctrine (a superior handing an actual
unit of work down to a subordinate), and the "peer-to-peer delegation" concept from
the authority-model interview (horizontal routing between structural peers, where
neither delegates authority to the other). Both create a linked child WorkOrder
(`work_orders.parent_work_order_id`) and produce an `agent_delegated` receipt. The
schema distinguishes them via `work_orders.delegation_mode`, deliberately not named
"vertical"/"horizontal" at the schema layer:

- **`'supervised'` (vertical).** The delegator has real hierarchical standing over
  the receiver, per §2's reporting chain — e.g. ELORA (executive) delegating to
  Nexora, once Nexora exists as a live actor. The receiver's authority for the
  delegated work is *intended* to be bounded by what the delegator themselves
  holds. **This bounding is not yet enforced.** `work_orders.delegated_authority_scope_note`
  is a free-text schema hook for a future phase to populate once a persona's actual
  positive authority scope exists to check against (Tier 2/3, unbuilt) — it is not
  validated or matched against anything today.
- **`'peer'` (horizontal).** The delegator and receiver are structural peers, with
  no authority relationship between them — e.g. Jynx routing work to Cassian. The
  receiver resolves the delegated work entirely under their own independent
  authority scope. No inheritance, no bounding, nothing to enforce by construction.

Neither mode currently implements real blocking or yield/resume behavior — a
delegating actor cannot yet actually pause and wait for the child WorkOrder to
complete. This is explicitly deferred, not silently missing: it requires a live
pipeline that actually needs to block, which is naturally whenever Nexora's (or
Kaz's, or Jynx's) real execution capability exists. Real authority-bounding
enforcement for the `'supervised'` mode has the same deferral — both wait on a live
decision-maker this phase does not build.

See `docs/architecture/core-runtime.md` §11 for the original generic delegation
mechanics (parent/child actor, delegated WorkOrder, context inheritance, yield/resume
state, return receipt) that `'supervised'` mode implements; that section now
cross-references here rather than duplicating this doctrine.

## 7. Scope of This Document

This document defines the hierarchy's structure, the standing-authorization
mechanism's policy, and the delegation mechanism's policy. It deliberately does
**not** cover, and no implementing agent should infer behavior for, the following —
each is scoped to its own later phase:

- **The authority resolution engine's runtime behavior** is built (Phase 6C,
  `src/elora/resolveAuthorityWithHierarchy.ts`) — walking the hierarchy and
  resolving standing rules against a live request. What remains unbuilt: enforcing
  that `authority_standing_rules.confirmed_by_actor_id` actually resolves to the
  Sovereign (documented in §3, not enforced at any layer yet).
- **Each persona's specific positive authority scope** — what Elora, or any Chief,
  Lieutenant, or Special Envoy, is actually granted — Tier 2/3, not this phase.
- **Real delegation blocking/yield-resume and supervised-mode authority-bounding
  enforcement** — see §6 above; deferred to whichever future phase has a live
  pipeline that actually needs them.

## 8. Deferred: The Swarm Layer

`hierarchy_tier` includes `'swarm'` in its CHECK constraint for schema
completeness. This is intentional future work, not a forgotten layer — the same
treatment `docs/architecture/core-runtime.md` §20 gives its own carried-forward
open questions. No actor holds the `swarm` tier as of Phase 6B, and its structural
role (a fan-out layer below Outer Circle? a peer pool? something else) is not
decided here. This remains open for a future planning pass and should not be
inferred by an implementing agent without explicit instruction.
