import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ingestUserMessage } from "../../elora/ingestUserMessage.js";
import { EloraError } from "../../elora/errors.js";
import { getDevIdentity } from "../devIdentity.js";

// Phase 6A §7: exactly one route. Thin adapter over ingestUserMessage() --
// no ingestion logic duplicated, no client-side reconstruction of anything
// the function already returns. Returns EloraIngestionResult verbatim.

const sendEloraMessageSchema = z.object({
  threadId: z.string().uuid().optional(),
  content: z.string().trim().min(1, "content must not be empty"),
  clientRequestId: z.string().trim().min(1, "clientRequestId must not be empty"),
});

interface ApiErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export const eloraMessagesRouter = Router();

eloraMessagesRouter.post("/api/elora/messages", async (req: Request, res: Response) => {
  const parsed = sendEloraMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(errorBody("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request body"));
    return;
  }

  const identity = getDevIdentity();
  if (!identity) {
    res
      .status(500)
      .json(
        errorBody(
          "DEV_IDENTITY_MISSING",
          "Dev identity is not configured. Run `pnpm tsx scripts/seedDevIdentity.ts` and restart the server.",
        ),
      );
    return;
  }

  try {
    const result = await ingestUserMessage({
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      threadId: parsed.data.threadId ?? null,
      actorId: identity.actorId,
      content: parsed.data.content,
      sourceSurface: "web-console",
      sourceCorrelationId: parsed.data.clientRequestId,
    });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof EloraError) {
      res.status(400).json(errorBody(error.name, error.message));
      return;
    }
    // eslint-disable-next-line no-console
    console.error("Unhandled error in POST /api/elora/messages:", error);
    res.status(500).json(errorBody("INTERNAL_ERROR", "An unexpected error occurred processing this message."));
  }
});
