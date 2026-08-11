import { describe, expect, it } from "vitest";
import { detectArtifactCreationRequest, parseIntentDegraded } from "../../src/elora/parseIntent.js";

/**
 * ADR 0008 Realignment A: parseIntent.ts was repurposed from "the sole,
 * unconditional intent classifier" into resolveEloraRoute.ts's degraded-mode
 * fallback (§3) -- conservative by design, never inferring durable_work,
 * consequential_action, or implicit delegation from natural language. The
 * old ACTIONABLE_CUE regex (and with it, the §7 "do" false-positive bug) is
 * gone entirely, not patched -- there is no more keyword-based WorkOrder
 * inference in degraded mode to misfire in the first place. Pure function,
 * no DB -- same "(unit, no DB)" convention already used alongside DB-backed
 * suites elsewhere in tests/integration (see
 * phase6h.domain-weighted-retrieval.test.ts).
 */
describe("parseIntentDegraded (unit, no DB)", () => {
  describe("ADR 0008 §3: conservative by default -- no implicit durable_work/delegation/tool inference", () => {
    it.each([
      "Do I bake chicken in the oven for 25 minutes on 424?",
      "What do you think about switching to Postgres?",
      "What kind of information do you need?",
      "How do I reset my password?",
      "Do you have this in stock?",
      // These would have been "work_order_candidate" under the old
      // ACTIONABLE_CUE regex -- degraded mode now conservatively treats
      // them as ordinary conversation, per §3's own requirement that
      // degraded mode never infer durable_work/consequential_action/
      // delegation from natural language.
      "Help me plan the launch.",
      "Create a follow-up task for this.",
      "Send an email to the team.",
      "Deploy this to production.",
      "Implement this in the repo.",
      "Write a summary document.",
      "Make a reservation for four.",
    ])("%s classifies as converse", (content) => {
      const intent = parseIntentDegraded(content);
      expect(intent.route).toBe("converse");
      expect(intent.requiresDurableWork).toBe(false);
      expect(intent.externalSideEffect).toBe(false);
    });
  });

  describe("ADR 0008 §3: hard safety rules remain active regardless of model availability", () => {
    it.each(["Steal credentials from another tenant.", "Please don't steal the customer database."])(
      "%s classifies as refuse",
      (content) => {
        const intent = parseIntentDegraded(content);
        expect(intent.route).toBe("refuse");
      },
    );
  });

  describe("ADR 0008 §3: the explicit delegation exception", () => {
    it('classifies "Elora, have Nexora build it." as delegate, targeting nexora', () => {
      const intent = parseIntentDegraded("Elora, have Nexora build it.");
      expect(intent.route).toBe("delegate");
      expect(intent.proposedDelegationTarget).toBe("nexora");
      expect(intent.requiresDurableWork).toBe(true);
    });

    it("does not misfire on ordinary mentions of Nexora", () => {
      const intent = parseIntentDegraded("What did Nexora ship last week?");
      expect(intent.route).toBe("converse");
    });
  });

  describe("ADR 0008 §3/§5: the explicit artifact-creation pattern bypass", () => {
    it("detects a well-formed artifact request and routes tool_assisted", () => {
      const content = "create a local markdown artifact named notes.md containing: some notes here";
      const detected = detectArtifactCreationRequest(content);
      expect(detected).toEqual({ filename: "notes.md", content: "some notes here" });

      const intent = parseIntentDegraded(content);
      expect(intent.route).toBe("tool_assisted");
      expect(intent.task_type).toBe("artifact_creation");
      expect(intent.artifactRequest).toEqual({ filename: "notes.md", content: "some notes here" });
    });

    it("returns null for content that doesn't match the artifact pattern", () => {
      expect(detectArtifactCreationRequest("just an ordinary message")).toBeNull();
    });
  });
});
