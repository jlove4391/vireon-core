import { Router, type Request, type Response } from "express";
import { GetLatestBriefingQuerySchema, IssueBriefingRequestSchema } from "@vireon/contracts";
import { BriefingError } from "../../briefing/errors.js";
import { getLatestBriefingIssue } from "../../briefing/getLatestBriefingIssue.js";
import { issueBriefing } from "../../briefing/issueBriefing.js";
import { getDevIdentity } from "../devIdentity.js";
import { toBriefingIssueDTO } from "../contracts/briefingIssueResponse.js";

// Phase 6M: same route pattern as eloraMessages.ts -- Zod-validated input,
// dev-identity for tenant scoping, typed-error -> 400 / unhandled -> 500,
// response self-validated (inside toBriefingIssueDTO) before it goes on
// the wire.

interface ApiErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function devIdentityMissingBody(): ApiErrorBody {
  return errorBody(
    "DEV_IDENTITY_MISSING",
    "Dev identity is not configured. Run `pnpm tsx scripts/seedDevIdentity.ts` and restart the server.",
  );
}

export const briefingsRouter = Router();

briefingsRouter.get("/api/briefings/latest", async (req: Request, res: Response) => {
  const parsed = GetLatestBriefingQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(errorBody("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid query parameters"));
    return;
  }

  const identity = getDevIdentity();
  if (!identity) {
    res.status(500).json(devIdentityMissingBody());
    return;
  }

  try {
    const detail = await getLatestBriefingIssue(identity.tenantId, parsed.data.briefingType);
    res.status(200).json({
      schemaVersion: "1",
      issue: detail ? toBriefingIssueDTO(detail) : null,
    });
  } catch (error) {
    if (error instanceof BriefingError) {
      res.status(400).json(errorBody(error.name, error.message));
      return;
    }
    // eslint-disable-next-line no-console
    console.error("Unhandled error in GET /api/briefings/latest:", error);
    res.status(500).json(errorBody("INTERNAL_ERROR", "An unexpected error occurred fetching the latest briefing."));
  }
});

briefingsRouter.post("/api/briefings/issue", async (req: Request, res: Response) => {
  const parsed = IssueBriefingRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(errorBody("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request body"));
    return;
  }

  const identity = getDevIdentity();
  if (!identity) {
    res.status(500).json(devIdentityMissingBody());
    return;
  }

  try {
    const result = await issueBriefing({
      tenantId: identity.tenantId,
      briefingType: parsed.data.briefingType,
      localIssueDate: parsed.data.localIssueDate,
      timezone: parsed.data.timezone,
      issuedByActorId: identity.actorId,
    });

    // issueBriefing() itself doesn't resolve display title/detail (that's
    // read-side concern, not part of the write) -- re-fetch through the
    // same read path GET /latest uses so both routes build the DTO from
    // one code path, not two divergent transforms. This is always the
    // just-issued (or just-confirmed-already-issued) row: it's the most
    // recently published issue of this type the instant after
    // issueBriefing() returns.
    const detail = await getLatestBriefingIssue(identity.tenantId, parsed.data.briefingType);
    if (!detail) {
      throw new Error("issueBriefing() succeeded but no latest briefing was found immediately after");
    }

    res.status(200).json({
      schemaVersion: "1",
      issue: toBriefingIssueDTO(detail),
      alreadyIssued: result.alreadyIssued,
    });
  } catch (error) {
    if (error instanceof BriefingError) {
      res.status(400).json(errorBody(error.name, error.message));
      return;
    }
    // eslint-disable-next-line no-console
    console.error("Unhandled error in POST /api/briefings/issue:", error);
    res.status(500).json(errorBody("INTERNAL_ERROR", "An unexpected error occurred issuing the briefing."));
  }
});
