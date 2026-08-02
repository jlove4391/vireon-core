import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ELORA_PERSONA, type PersonaConfig } from "@vireon/persona-config";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { generateEloraResponse } from "../../src/elora/generateEloraResponse.js";
import type { LlmProvider, LlmResponseContext } from "../../src/elora/llm/types.js";
import { buildPrompt } from "../../src/elora/llm/anthropicProvider.js";
import { FakeLlmProvider } from "../../src/elora/llm/fakeProvider.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

// Hoisted mutable mock state -- vi.mock factories are hoisted above imports,
// so any state they close over must be created via vi.hoisted().
const mockState = vi.hoisted(() => ({
  calls: [] as Array<{ context: unknown; timeoutMs: number }>,
  behavior: "success" as "success" | "timeout" | "error" | "empty",
  responseText: "Mocked in-character reply.",
}));

vi.mock("../../src/elora/llm/anthropicProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/elora/llm/anthropicProvider.js")>();
  class MockAnthropicProvider {
    constructor(_apiKey: string) {}
    async generateResponse(context: unknown, timeoutMs: number): Promise<string> {
      mockState.calls.push({ context, timeoutMs });
      if (mockState.behavior === "timeout") {
        throw new Error("simulated timeout");
      }
      if (mockState.behavior === "error") {
        throw new Error("simulated API error");
      }
      if (mockState.behavior === "empty") {
        return "";
      }
      return mockState.responseText;
    }
  }
  return { ...actual, AnthropicProvider: MockAnthropicProvider };
});

// PR 2: LlmProvider gained five new required methods -- FakeLlmProvider is
// the single, long-term seam for every LlmProvider test double (locked
// decision), so these generateEloraResponse-only unit tests build on it
// (only ever overriding generateResponse, the one method they actually
// exercise) instead of hand-rolling six-method object literals that would
// now fail to typecheck.
function stubProvider(generateResponse: LlmProvider["generateResponse"]): LlmProvider {
  return new FakeLlmProvider({ generateResponse });
}

function baseLlmContext(overrides: Partial<LlmResponseContext> = {}): LlmResponseContext {
  return {
    persona: ELORA_PERSONA,
    userMessageContent: "test message",
    taskType: "planning",
    authorityOutcome: "act_and_report",
    reason: "test reason",
    finalWorkOrderStatus: "READY_TO_ACT",
    toolResult: null,
    retrievedMemorySnippets: [],
    ...overrides,
  };
}

describe("Phase 6F: generateEloraResponse -- fallback correctness (unit, no DB, no mocked module)", () => {
  it("3a. timeout -> deterministic fallback, not thrown", async () => {
    const provider = stubProvider(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 5)));
    const result = await generateEloraResponse({
      context: baseLlmContext(),
      deterministicFallback: "FALLBACK-TEXT",
      provider,
    });
    expect(result).toBe("FALLBACK-TEXT");
  });

  it("3b. API error -> deterministic fallback, not thrown", async () => {
    const provider = stubProvider(async () => {
      throw new Error("simulated API error");
    });
    const result = await generateEloraResponse({
      context: baseLlmContext(),
      deterministicFallback: "FALLBACK-TEXT",
      provider,
    });
    expect(result).toBe("FALLBACK-TEXT");
  });

  it("3c. empty response -> deterministic fallback", async () => {
    const provider = stubProvider(async () => "");
    const result = await generateEloraResponse({
      context: baseLlmContext(),
      deterministicFallback: "FALLBACK-TEXT",
      provider,
    });
    expect(result).toBe("FALLBACK-TEXT");
  });

  it("3d. whitespace-only / absurdly long response -> deterministic fallback (sanity check fails)", async () => {
    const whitespaceProvider = stubProvider(async () => "   \n\t  ");
    expect(
      await generateEloraResponse({ context: baseLlmContext(), deterministicFallback: "FALLBACK-TEXT", provider: whitespaceProvider }),
    ).toBe("FALLBACK-TEXT");

    const tooLongProvider = stubProvider(async () => "x".repeat(5000));
    expect(
      await generateEloraResponse({ context: baseLlmContext(), deterministicFallback: "FALLBACK-TEXT", provider: tooLongProvider }),
    ).toBe("FALLBACK-TEXT");
  });

  it("success: a well-formed response is used, not the fallback", async () => {
    const provider = stubProvider(async () => "A real, sane in-character reply.");
    const result = await generateEloraResponse({
      context: baseLlmContext(),
      deterministicFallback: "FALLBACK-TEXT",
      provider,
    });
    expect(result).toBe("A real, sane in-character reply.");
  });

  it("no provider available (no key, disabled) -> deterministic fallback directly, no attempt", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await generateEloraResponse({ context: baseLlmContext(), deterministicFallback: "FALLBACK-TEXT" });
      expect(result).toBe("FALLBACK-TEXT");
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

describe("Phase 6F: buildPrompt -- persona genericness (unit, no DB)", () => {
  it("4. prompt construction uses the passed persona's own fields, not a hardcoded Elora reference", () => {
    // Full PersonaConfig, not just the prompt-relevant subset -- proves
    // buildPrompt() only reads the fields it needs off the consolidated
    // type and tolerates (ignores) the rest, same as it does for the real
    // ELORA_PERSONA's unused-here fields (crestAssetPath, accentColor, etc.).
    const throwawayPersona: PersonaConfig = {
      id: "test-persona-zeta",
      name: "Test Persona Zeta",
      formalTitle: "Grand Archivist of Nowhere",
      corporateRole: "Chief Testing Officer",
      voiceTone: ["Bone-dry", "Deadpan"],
      crestAssetPath: "/assets/crests/test-persona-zeta.png",
      accentColor: { primary: "#000000", secondary: "#ffffff" },
      pronouns: "they/them",
      genderIdentity: "nonbinary",
      voiceModelId: null,
      domain: null,
      actorName: "Test Persona Zeta",
    };

    const throwawayPrompt = buildPrompt(baseLlmContext({ persona: throwawayPersona }));
    expect(throwawayPrompt.system).toContain("Test Persona Zeta");
    expect(throwawayPrompt.system).toContain("Grand Archivist of Nowhere");
    expect(throwawayPrompt.system).toContain("Chief Testing Officer");
    expect(throwawayPrompt.system).toContain("Bone-dry");
    expect(throwawayPrompt.system).toContain("they/them");
    expect(throwawayPrompt.system).not.toContain("Elora");

    const eloraPrompt = buildPrompt(baseLlmContext({ persona: ELORA_PERSONA }));
    expect(eloraPrompt.system).toContain("Elora");
    expect(eloraPrompt.system).not.toBe(throwawayPrompt.system);
  });
});

describe("Phase 6F: real pipeline wiring -- ordering and fallback, via mocked AnthropicProvider", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  // Save/restore, not delete-unconditionally: this file may run in an
  // environment with a real ANTHROPIC_API_KEY already set (the optional
  // real-model describe block below needs it) -- earlier tests here must
  // not permanently wipe it out from under later ones in the same file.
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    mockState.calls = [];
    mockState.behavior = "success";
    mockState.responseText = "Mocked in-character reply.";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    delete process.env.ELORA_LLM_DISABLED;
  });

  it("2. ordering: the provider is invoked exactly once, with the already-finalized outcome matching the function's own final result", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me draft a project plan for the initiative.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(mockState.calls).toHaveLength(1);
    const captured = mockState.calls[0]!.context as LlmResponseContext;
    // The context handed to the provider carries exactly the already-decided
    // outcome that ended up being the function's own official result --
    // never a value that was still in progress or later changed.
    expect(captured.authorityOutcome).toBe(result.authorityOutcome);
    expect(captured.finalWorkOrderStatus).toBe(result.finalWorkOrderStatus);
    expect(captured.finalWorkOrderStatus).toBe("READY_TO_ACT");
    expect(result.responseText).toBe("Mocked in-character reply.");
  });

  it("2b. ordering on a blocked (escalate) branch: provider sees the finalized AWAITING_AUTHORIZATION outcome", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Send an email to the team and deploy this to production.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(mockState.calls).toHaveLength(1);
    const captured = mockState.calls[0]!.context as LlmResponseContext;
    expect(captured.finalWorkOrderStatus).toBe("AWAITING_AUTHORIZATION");
    expect(captured.finalWorkOrderStatus).toBe(result.finalWorkOrderStatus);
    expect(captured.authorityOutcome).toBe("escalate");
    expect(result.responseText).toBe("Mocked in-character reply.");
  });

  it("2c. ordering on the tool-execution path: toolResult is populated only after real completion, matching the persisted artifact", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Create a local markdown artifact named phase6f-probe.md containing: llm ordering probe.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(mockState.calls).toHaveLength(1);
    const captured = mockState.calls[0]!.context as LlmResponseContext;
    expect(captured.finalWorkOrderStatus).toBe("COMPLETED");
    expect(captured.finalWorkOrderStatus).toBe(result.finalWorkOrderStatus);
    expect(captured.toolResult).toEqual({ toolName: "core.artifact.write", artifactFilename: "phase6f-probe.md" });
    expect(result.artifactId).not.toBeNull();
  });

  it("3. fallback correctness through the real pipeline: timeout never produces a blank response or a thrown error", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockState.behavior = "timeout";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me draft a status update.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.responseText.length).toBeGreaterThan(0);
    expect(result.responseText).not.toBe("Mocked in-character reply.");
  });

  it("3. fallback correctness through the real pipeline: API error never produces a blank response or a thrown error", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockState.behavior = "error";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me draft another status update.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.responseText.length).toBeGreaterThan(0);
    expect(result.responseText).not.toBe("Mocked in-character reply.");
  });

  it("3. fallback correctness through the real pipeline: empty/malformed response never produces a blank response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockState.behavior = "empty";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me draft yet another status update.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.responseText.length).toBeGreaterThan(0);
    expect(result.responseText).not.toBe("Mocked in-character reply.");
  });

  it("1. no ANTHROPIC_API_KEY set: pipeline behaves exactly as the pre-6F deterministic path (mock never invoked)", async () => {
    // Explicitly unset for this one, regardless of whatever this
    // environment's real value is (afterEach restores it afterward) --
    // proves 6F is behavior-preserving by default when no key is present,
    // same property 6C established for standing rules.
    delete process.env.ANTHROPIC_API_KEY;
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me draft one more status update.",
      sourceSurface: "phase6f-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(mockState.calls).toHaveLength(0);
    expect(result.responseText.length).toBeGreaterThan(0);
  });
});

describe("Phase 6F: safety checks", () => {
  it("7. ANTHROPIC_API_KEY is never read anywhere in apps/web", async () => {
    const webSrcRoot = path.join(REPO_ROOT, "apps", "web", "src");

    async function collectFiles(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) return collectFiles(fullPath);
          if (/\.(ts|tsx)$/.test(entry.name)) return [fullPath];
          return [];
        }),
      );
      return files.flat();
    }

    const files = await collectFiles(webSrcRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      expect(content).not.toContain("ANTHROPIC_API_KEY");
    }
  });
});

describe("Phase 6F: optional real-model end-to-end (only runs with a genuine ANTHROPIC_API_KEY)", () => {
  const hasRealKey = Boolean(process.env.ANTHROPIC_API_KEY);

  it.skipIf(!hasRealKey)("5. a real Anthropic call produces a sensible, non-empty, in-character response", async () => {
    // Explicitly bypasses this file's own AnthropicProvider mock --
    // vi.importActual always returns the real, unmocked module regardless
    // of vi.mock() elsewhere in this file.
    const real = await vi.importActual<typeof import("../../src/elora/llm/anthropicProvider.js")>(
      "../../src/elora/llm/anthropicProvider.js",
    );
    const provider = new real.AnthropicProvider(process.env.ANTHROPIC_API_KEY!);
    const text = await provider.generateResponse(
      baseLlmContext({ userMessageContent: "Help me draft a short project status update." }),
      30_000,
    );
    expect(text.trim().length).toBeGreaterThan(0);
  });

  // Not skipped -- always runs, and documents the skip decision explicitly
  // rather than letting the suite silently omit coverage.
  it("documents whether the optional real-model test ran", () => {
    if (!hasRealKey) {
      // eslint-disable-next-line no-console
      console.log(
        "Phase 6F optional real-model test SKIPPED: no ANTHROPIC_API_KEY present in this environment.",
      );
    }
    expect(true).toBe(true);
  });
});

// Item 6 (git diff shows zero changes to parseIntent.ts and classifyAuthority.ts)
// is verified by `git diff`, and item 8 (manual visual verification) by
// actually running the stack -- see the Phase 6F completion report, not
// this file. Item 9 (full regression) is verified by running the full
// `pnpm test` suite with no ANTHROPIC_API_KEY set.
