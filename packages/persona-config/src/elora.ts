import type { PersonaConfig } from "./types.js";

// The one real PersonaConfig instance today. Consolidated from the
// frontend's former apps/web/src/lib/personaConfig.ts and the backend's
// former src/elora/llm/personaVoiceProfiles.ts (ELORA_VOICE_PROFILE) --
// same values, single source of truth. actorName confirmed against
// scripts/seedPersonaRoster.ts's PERSONA_ROSTER entry, not invented.
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
  actorName: "Elora",
};
