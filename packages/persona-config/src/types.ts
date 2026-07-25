// Prep Pass: Persona Identity Consolidation. Distinct from
// packages/contracts (6E) -- that package is specifically for HTTP-boundary
// DTOs; PersonaConfig is a static configuration object, not a
// request/response shape.
//
// One complete type, not a "shared core" plus per-consumer extensions --
// not every field is used by every consumer (crestAssetPath is
// frontend-only in practice, and that's fine, per the same pattern 6E's
// EloraMessageResponseSchema already established: not every field is read
// by every UI component).

export interface PersonaConfig {
  id: string;
  name: string;
  formalTitle: string;
  corporateRole: string;
  voiceTone: string[];
  crestAssetPath: string;
  accentColor: {
    primary: string;
    secondary: string;
  };
  /**
   * Placeholder only -- classifyAuthority.ts is not persona-aware (there is
   * only ELORA's own classifier). This field exists so the shape is ready
   * for a future persona-aware authority model, but it must never be wired
   * to anything that pretends to enforce it in 6A.
   */
  authorityScope?: string;
  /** Phase 6F §7: confirmed from ELORA.md's consistent usage, not invented. */
  pronouns: string;
  genderIdentity: string;
  /** Phase 6F §7: stays null -- real voice model integration is unscheduled. */
  voiceModelId: string | null;
  /**
   * Phase 6G §8: e.g. "finance" once Jynx exists; null for Elora
   * (executive-tier, sees the full pool). Deliberately unused by any
   * retrieval logic until 6H.
   */
  domain: string | null;
  /**
   * MUST exactly match the actor_name seeded for this persona in the
   * actors table (Phase 6B, scripts/seedPersonaRoster.ts). This is the
   * real, declared, tested join key between a PersonaConfig and its
   * corresponding actors row -- not the id field (a lowercase slug)
   * coincidentally matched against actor_name by convention. See the
   * live-data contract test in this package's test suite, which verifies
   * this field against the real seeded actors table for every known
   * PersonaConfig instance.
   */
  actorName: string;
}
