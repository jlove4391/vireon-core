# Vireon CORE — Roadmap

*Revision 4 (2026-07-19). Supersedes all prior Drive-hosted revisions
(v1–v3). This is now the canonical, version-controlled copy of the
roadmap — kept in sync with future revisions in place, not superseded by
a new file each time. Prior Drive revisions remain there for historical
reference only.*

---

## 1. What Changed Since v3

- **6E, 6F, and 6G are complete and merged** (PRs #13, #14 + #15, #16) —
  the UI contract layer, real Anthropic LLM integration (proven against
  a live model, not just mocks), and the memory review/promotion
  pipeline are all real, tested infrastructure now.
- **What v3 called "6G — Memory Continuity" turned out to be two
  genuinely separate phases**, discovered during planning: reviewing/
  promoting proposed memories (schema + service + CLI, no retrieval
  change) is a different piece of work from actually using memory's
  `scope` label to weight what gets retrieved. Splitting them, consistent
  with how 6B/6C and 6H/6I were each split earlier in this roadmap,
  pushed the previously-planned trigger phases down one letter: **6H
  (Scheduled Trigger Schema) is now 6I, and 6I (Trigger Execution Engine)
  is now 6J.**
- **Memory's domain-labeling design was deliberately kept minimal**: one
  real label (`"general"`) exists today; real domain values (`"finance"`,
  `"engineering"`, etc.) are added only when the specific persona who
  needs them is actually built, not guessed at in advance. See §3's 6G/6H
  entries for the full reasoning — worth reading in full if this needs to
  be revisited later without full context in memory.

## 2. Status — Completed and Merged

| Phase | Delivered | Status |
|---|---|---|
| 0 | Repo doctrine and contracts | Complete |
| 1 | Local infrastructure, database spine, tenant-isolated RLS | Merged |
| 2 | CORE WorkOrder state machine v1 | Merged |
| 2.5 | Diagnostic Runtime Console | Merged |
| 3 | ELORA v1 — deterministic conversational ingestion runtime | Merged |
| 4 | Receipts and Authority-v2 | Merged |
| 5 | Internal tool registry v1 | Merged |
| 6A | ELORA Console — minimal UI foundation | Merged |
| 6B | Authority Hierarchy — schema, policy, 31-persona roster seeded | Merged (PR #10) |
| 6C | Authority Resolution Engine | Merged (PR #11) |
| 6D | Delegation — vertical (supervised) and peer, reconciled as one mechanism | Merged (PR #12) |
| 6E | Stable UI-Facing Contract Layer — shared Zod package, hand-mirror risk closed | Merged (PR #13) |
| 6F | Generic LLM Integration — real Anthropic calls, deterministic-fallback guaranteed, proven live | Merged (PR #14 + #15) |
| 6G | Memory Review & Promotion — review/approve/reject/promote service, CLI-driven | Merged (PR #16) |

Everything through 6A is fully deterministic. 6F introduced ELORA's first
genuinely non-deterministic output — LLM-generated response text — with
a guaranteed deterministic fallback if the model call fails, times out,
or is unavailable.

## 3. Tier 1 — Cross-Cutting Infrastructure (Remaining)

### 6G — Memory Review & Promotion (complete, summarized for context)

Closed the gap between "memory candidates get proposed" (Phase 3) and
"candidates get reviewed and turned into durable memory" (never built
until now). A real `reviewMemoryCandidate()`/`promoteMemoryCandidate()`
service, CLI-driven (no HTTP route or UI yet — same precedent Phase 2.5
set for WorkOrder inspection). Reconciled a real data problem found
during planning: every memory candidate ever created had a leftover
placeholder `scope` value (`"project"`), relabeled honestly to
`"general"` rather than reverse-guessing what domain each was really
about.

**Memory-scope design, stated plainly for future reference:** the
`scope` column is free text, no fixed list of allowed values. Exactly
one real label is in use today — `"general"`. Real domain labels
(`"finance"` for Jynx, `"engineering"` for Nexora, `"business"` for Kaz,
etc.) get added only when that specific persona is actually built — not
pre-populated now. This was a deliberate choice: guessing at a full
label system before most of the personas who'd use it exist would mean
guessing wrong and having to fix it later, whereas adding a new label
later costs nothing (no database change, just a new persona's code using
a new word for the first time). `PersonaConfig` already carries a
`domain` field for this purpose (null for Elora, who is executive-tier
and sees the full memory pool regardless of label).

### 6H — Domain-Weighted Retrieval & Exposure (renumbered; was informally referenced as "6G's second half" during 6G's planning)

Extends `retrieveRelevantMemory.ts` to actually use the `scope` label 6G
established — weighting retrieval toward a requesting persona's own
domain (via the `PersonaConfig.domain` field), while ELORA continues to
see the full, unweighted pool. Also decides what — if anything —
`EloraMessageResponseSchema` (6E's contract) should expose about
retrieved memory to the UI; `retrievedMemoryIds`/`retrievedMemoryCount`
already exist on the internal `EloraIngestionResult` type but were
deliberately excluded from the HTTP contract when 6E was built, flagged
at the time as an expected future addition once 6G/6H made them
meaningful. A memory-candidate review *screen* in the UI remains further
out — part of whatever later pass adds the broader governance-visibility
screens (WorkOrder queue, receipt viewer), not assumed to follow directly
from 6H.

### 6I — Scheduled Trigger Schema & Creation (renumbered from 6H)

Unchanged in content from the prior revision — closes the gap that every
WorkOrder has always required a live human message to originate. A
scheduled trigger is a persisted record (owning persona, schedule,
synthetic message content) that feeds a system-originated message
through the existing `ingestUserMessage()` pipeline. Creating a trigger
is an ordinary authority-classified action, resolved through the normal
hierarchy — not a special Sovereign-only gate (corrected during the
original 6H/6I planning pass). Condition-based monitoring (fraud/anomaly
flagging) is a scheduled trigger with a conditional check inside it, not
a separate primitive.

### 6J — Trigger Execution Engine (renumbered from 6I)

Unchanged in content — the actual runner that checks for due triggers
and feeds them into the pipeline. First real use of Redis, dormant in
this stack since Phase 1. Sequenced after 6F (already complete)
specifically so a trigger fires into real generated language, not a
template.

### Prep Pass — Persona-Generic Renaming

Unchanged: immediately before Nexora's build, rename
`elora_ingestion_completed`/`elora_request_blocked` receipt types and
`ELORA_WORKSPACE_*` env vars to persona-generic equivalents.

## 4. Tier 2 — ELORA Fully Realized

- **2a — Google Suite.** Drive search/read, Docs create/update, Sheets,
  Slides, Gmail read/draft/send with authority controls, Calendar
  read/create/update with authority controls, Contacts lookup.
- **2b — Meet/Zoom transcription.** ELORA-exclusive. She processes the
  meeting and produces a transcript, then hands it to the domain-owning
  persona via 6D's supervised delegation mode.
- **2c — ELORA's positive authority scope**, finalized as real
  configuration — an explicit, bounded grant of what she can silently
  resolve. Permanently excludes RMTs, sensitive-data handling, and
  irreversible actions.
- **2d — Conversational tuning**, meaningfully easier now that 6F's real
  LLM integration already exists.

## 5. Tier 3 — Nexora Fully Realized

Sandbox v1 (Docker boundary, worktrees), her own tool registry (repo
inspection, patch proposal, validated commands), her own authority scope
layered on the hybrid floor. Open questions from earlier planning remain
open, to be resolved during her own dedicated pass: real repo push/
merge/commit (escalate-by-default, standing-authorization-eligible over
time), scoped network access for dependency installation, and
credential/secret injection for testing (its own separate design
problem).

## 6. Tier 4 — Kaz (Cassian) Fully Realized

Domain: business creation, scaling, market opportunity scouting,
leadership/venture mentoring — fundamentally advisory and analytical.

- **Market/financial data** via real web crawls: market growth
  projections, emerging market-lane identification, business/market
  value vs. profit analysis for acquisition scenarios. Not live trading
  data, not account access — that's Jynx's domain.
- **Tools:** Google Sheets/Slides/Docs (granted from Tier 2's generic
  registry) for models, decks, and business planning documents.
- **Knowledge scope restricted to business-related information and
  topics only.**
- **Peer relationship with Jynx:** he can query her directly for
  TLC/Vireon-specific financial information via 6D's peer delegation
  mode.
- **Authority scope:** drafting/analysis is ordinary, low-risk
  (`act_and_report`). Anything constituting an actual legally-binding
  commitment — a real contract, a formal proposal sent to a third party —
  always escalates, under the existing irreversible-action floor
  category. Drafting stays safe; sending/finalizing does not.

## 7. Tier 5 — Jynx Fully Realized

Domain: finance, combined CFP + CPA + CFO scope — the Crown Treasurer
role. **This is the highest-stakes integration in the entire project** —
her domain sits squarely inside the floor's primary permanently-protected
category (real money transactions), more consequential in real-world
terms than anything Nexora's sandbox touches. Her build deserves its own
careful, dedicated design pass when the time comes — not a checklist
item.

- **Real integration required**, not just user-provided data: bank and
  brokerage accounts, and a bookkeeping platform (e.g. QuickBooks). Exact
  integration design (read scope, credential handling, authentication)
  explicitly deferred to her own dedicated planning pass.
- **Works in tandem with Kaz** on budgets and forecasts — the other half
  of the confirmed peer-delegation pairing.
- **Full active/defensive CFO scope**: fraud flagging and anomaly alerts
  (via 6I's conditional-trigger pattern), investment strategy, tax
  shelter and tax break optimization — not limited to passive reporting.
- **The floor holds absolutely, without exception:** any action that
  actually moves money or commits funds is a real money transaction —
  permanently floor-protected `escalate`, never eligible for standing
  pre-authorization, regardless of how many times a similar action has
  been approved before. Reporting, monitoring, flagging, and
  recommending stay in her ordinary authority scope; *moving* money never
  does.

## 8. The Alpha Milestone

A live demonstration of two fully conversational persona pairings —
**ELORA↔Nexora** (vertical escalation and delegation) and **Kaz↔Jynx**
(horizontal peer delegation) — resolving against the real, running
authority system, using whatever real work is actually in front of the
system at the time. No named demo project is baked into the definition
itself. Alpha means the system is ready to be put in front of people for
demonstration.

## 9. Traceability — Original Phase Numbers

| Original | Original Content | Current Location |
|---|---|---|
| Phase 6 | Nexora work order spine | Tier 3 |
| Phase 7 | Sandbox v1 | Tier 3 |
| Phase 8 | Minimal UI | Phase 6A (merged) + Tier 1 §6E |
| Phase 9 | Google action spine | Tier 2 (§2a), expanded with Sheets/Slides + transcription (§2b) |
| Phase 10 | ELORA ↔ Nexora delegation (narrow, two-persona-specific) | Superseded by 6D (generic mechanism, any persona pairing) + the Alpha Milestone |

## 10. Doctrine — Status

`AUTHORITY_AND_DELEGATION.md` exists and is real, current doctrine (built
across 6B and 6D, including delegated-child-identity guidance added
during a post-6D fix). `core-runtime.md` §11 carries a reconciling note
pointing to it. Both integrated into `README.md`'s documentation map and
`AGENTS.md`'s authority section.

## 11. Explicitly Deferred — Not Scheduled

- **Swarm layer** — a no-authority worker tier beneath Outer Circle,
  everything unsafe auto-escalating up the chain. Deliberately deferred:
  no concrete current need justifies the dispatch/monitoring/aggregation
  infrastructure it would require.
- **Additional personas beyond Elora/Nexora/Kaz/Jynx** — each gets their
  own tier later, following the same pattern.
- **Microsoft Suite** — a real anticipated future need, explicitly
  reserved as a named slot rather than silently dropped, but not
  designed or built until a real persona need identifies specifically
  what's required.
- **Real verbal voice conversation** — live speech in and out (STT/TTS,
  real session/streaming infrastructure), distinct from the person
  simply dictating text via their own device's speech-to-text into a
  still-fundamentally-text system, which is all that exists today.
  `PersonaConfig.voiceModelId` (6F) is a placeholder hook, not a plan.
- **CORE Echo** — a separate product: a slimmed-down, user-created-
  persona version of CORE for business leaders/solopreneurs, with an
  authority posture that eases as it learns its specific user.
  Explicitly sequenced third, after Vireon CORE and Vireon AP Command are
  both complete.

## 12. Process Note

This document is strategic and sequencing-level. It does not replace the
dedicated decisions-first planning pass every phase still receives
before implementation — grounded in direct, current repository
inspection, not assumption.