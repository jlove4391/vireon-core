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
};
