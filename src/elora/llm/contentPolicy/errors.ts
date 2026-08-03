import type { ModelDataClassification } from "./types.js";

export class SensitiveContextBlockedError extends Error {
  constructor(
    public readonly classification: ModelDataClassification,
    public readonly reason: string,
  ) {
    super(`Model operation input blocked by content policy (classification: ${classification}): ${reason}`);
    this.name = "SensitiveContextBlockedError";
  }
}
