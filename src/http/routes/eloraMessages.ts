import { Router, type Request, type Response } from "express";
import { SendEloraMessageRequestSchema } from "@vireon/contracts";
import { ingestUserMessage } from "../../elora/ingestUserMessage.js";
import { EloraError } from "../../elora/errors.js";
import { getDevIdentity } from "../devIdentity.js";
import { toEloraMessageResponse } from "../contracts/eloraMessageResponse.js";

// Phase 6A §7: exactly one route. Thin adapter over ingestUserMessage().
// Phase 6E: the request schema now lives in the shared @vireon/contracts
// package (moved from a locally-declared schema, for symmetry with the
// response side), and the response is no longer EloraIngestionResult
// verbatim -- it's transformed through the stable, narrower
// EloraMessageResponse contract before it goes on the wire.

interface ApiErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export const eloraMessagesRouter = Router();

eloraMessagesRouter.post("/api/elora/messages", async (req: Request, res: Response) => {
  const parsed = SendEloraMessageRequestSchema.safeParse(req.body);
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
    res.status(200).json(toEloraMessageResponse(result));
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
