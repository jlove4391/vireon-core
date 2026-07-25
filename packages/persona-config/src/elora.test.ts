import { describe, expect, it } from "vitest";
import { ELORA_PERSONA } from "./elora.js";
import type { PersonaConfig } from "./types.js";

describe("ELORA_PERSONA", () => {
  it("satisfies the PersonaConfig shape with every field populated correctly", () => {
    const persona: PersonaConfig = ELORA_PERSONA;
    expect(persona).toEqual({
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
    });
  });

  it("actorName is the real declared join key -- not derived from id", () => {
    expect(ELORA_PERSONA.actorName).toBe("Elora");
    expect(ELORA_PERSONA.actorName).not.toBe(ELORA_PERSONA.id);
  });
});
