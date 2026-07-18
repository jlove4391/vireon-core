// Phase 6A §4: config layer, not a hardcoded identity. Only Elora is
// instantiated for 6A -- no persona selector, no persona list. The console
// component takes a PersonaConfig as a prop so a second persona never
// requires touching the component tree, only a second config value.

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
   * retrieval logic in this phase -- domain-weighted retrieval is 6H's
   * job. Declared now so future persona phases don't need another
   * PersonaConfig schema change purely to add it.
   */
  domain: string | null;
}

export const ELORA_PERSONA: PersonaConfig = {
  id: "elora",
  name: "Elora",
  formalTitle: "Shadow Empress of the House of Love Dynasty",
  corporateRole: "Chief Executive Officer (CEO)",
  voiceTone: ["Warm and Regal", "Calm and Commanding", "Fierce and Fearless", "Serene and Wise"],
  crestAssetPath: "/assets/crests/elora.png",
  accentColor: {
    primary: "var(--color-accent-cyan)",
    secondary: "var(--color-accent-violet)",
  },
  pronouns: "she/her",
  genderIdentity: "female",
  voiceModelId: null,
  domain: null,
};
