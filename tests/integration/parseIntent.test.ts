import { describe, expect, it } from "vitest";
import { parseIntent } from "../../src/elora/parseIntent.js";

/**
 * ADR 0008 §7 regression coverage: bare "do" was removed from parseIntent.ts's
 * ACTIONABLE_CUE regex because it's an auxiliary verb, not an action verb,
 * and matched ordinary questions indistinguishably from real imperatives.
 * Pure function, no DB -- same "(unit, no DB)" convention already used
 * alongside DB-backed suites elsewhere in tests/integration
 * (see phase6h.domain-weighted-retrieval.test.ts).
 */
describe("parseIntent (unit, no DB)", () => {
  describe("ADR 0008 §7: bare 'do' no longer misroutes ordinary questions to work_order_candidate", () => {
    it.each([
      "Do I bake chicken in the oven for 25 minutes on 424?",
      "What do you think about switching to Postgres?",
      "What kind of information do you need?",
      "How do I reset my password?",
      "Do you have this in stock?",
    ])("%s classifies as informational, not work_order_candidate", (content) => {
      const intent = parseIntent(content);
      expect(intent.intent_type).toBe("informational");
    });
  });

  describe("genuine actionable cues still classify as work_order_candidate", () => {
    it.each([
      "Help me plan the launch.",
      "Create a follow-up task for this.",
      "Send an email to the team.",
      "Deploy this to production.",
      "Implement this in the repo.",
      "Write a summary document.",
      "Make a reservation for four.",
      "Steal credentials from another tenant.",
      // Not "Manufacture the part." -- ACTIONABLE_CUE's \bmanufactur\b (and
      // \banalyz\b) are word-stem entries with a trailing \b, which can
      // only ever match the literal standalone token "manufactur"/"analyz",
      // never "manufacture"/"analyze"/"analyzing" (no word boundary exists
      // between a stem and its own suffix). Pre-existing, out of scope for
      // ADR 0008 §7's "drop bare do" fix -- flagged separately, not fixed here.
    ])("%s classifies as work_order_candidate", (content) => {
      const intent = parseIntent(content);
      expect(intent.intent_type).toBe("work_order_candidate");
    });
  });
});
