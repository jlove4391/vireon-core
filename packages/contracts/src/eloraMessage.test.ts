import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EloraMessageResponseSchema, SendEloraMessageRequestSchema } from "./eloraMessage.js";

function validResponsePayload(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    threadId: randomUUID(),
    messageId: randomUUID(),
    isDuplicateMessage: false,
    responseType: "direct_answer",
    responseText: "Here is your plan.",
    workOrderId: randomUUID(),
    authorityOutcome: "act_and_report",
    finalWorkOrderStatus: "READY_TO_ACT",
    actionReceiptId: randomUUID(),
    blockedReceiptId: null,
    toolInvocationId: null,
    artifactId: null,
    artifactFilename: null,
    memoryCandidateIds: [],
  };
}

describe("EloraMessageResponseSchema", () => {
  it("1. accepts a well-formed payload with every field populated", () => {
    const payload = validResponsePayload();
    const parsed = EloraMessageResponseSchema.parse(payload);
    expect(parsed).toEqual(payload);
  });

  it("1b. accepts a well-formed payload with every nullable field null", () => {
    const payload = {
      ...validResponsePayload(),
      workOrderId: null,
      authorityOutcome: null,
      finalWorkOrderStatus: null,
      actionReceiptId: null,
      blockedReceiptId: null,
      toolInvocationId: null,
      artifactId: null,
      artifactFilename: null,
    };
    expect(() => EloraMessageResponseSchema.parse(payload)).not.toThrow();
  });

  it("2. rejects a payload missing a required field", () => {
    const payload = validResponsePayload();
    delete payload.responseText;
    const result = EloraMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("2b. rejects a payload with the wrong type on a field", () => {
    const payload = { ...validResponsePayload(), isDuplicateMessage: "false" };
    const result = EloraMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("2c. rejects an invalid schemaVersion", () => {
    const payload = { ...validResponsePayload(), schemaVersion: "2" };
    const result = EloraMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("2d. rejects an unrecognized authorityOutcome/responseType enum value", () => {
    expect(EloraMessageResponseSchema.safeParse({ ...validResponsePayload(), authorityOutcome: "bogus" }).success).toBe(
      false,
    );
    expect(EloraMessageResponseSchema.safeParse({ ...validResponsePayload(), responseType: "bogus" }).success).toBe(
      false,
    );
  });

  it("2e. rejects a non-uuid id field", () => {
    const result = EloraMessageResponseSchema.safeParse({ ...validResponsePayload(), messageId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("SendEloraMessageRequestSchema", () => {
  it("accepts a well-formed request with and without threadId", () => {
    expect(
      SendEloraMessageRequestSchema.safeParse({ content: "hello", clientRequestId: randomUUID() }).success,
    ).toBe(true);
    expect(
      SendEloraMessageRequestSchema.safeParse({
        threadId: randomUUID(),
        content: "hello",
        clientRequestId: randomUUID(),
      }).success,
    ).toBe(true);
  });

  it("rejects empty content and empty clientRequestId", () => {
    expect(SendEloraMessageRequestSchema.safeParse({ content: "", clientRequestId: randomUUID() }).success).toBe(
      false,
    );
    expect(SendEloraMessageRequestSchema.safeParse({ content: "hello", clientRequestId: "" }).success).toBe(false);
  });
});
