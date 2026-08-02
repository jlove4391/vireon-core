// Phase 6M: thin client for the Operator Deck's two routes -- same
// pattern as api.ts (Phase 6A/6E): request/response shapes imported from
// the shared @vireon/contracts package, response genuinely validated at
// runtime before the caller ever sees it, no client-side reconstruction
// of anything the server response already carries.

import {
  IssueBriefingRequestSchema,
  IssueBriefingResponseSchema,
  LatestBriefingResponseSchema,
  type BriefingIssueDTO,
  type IssueBriefingRequest,
  type IssueBriefingResponse,
} from "@vireon/contracts";

export type { BriefingIssueDTO, IssueBriefingRequest, IssueBriefingResponse };

export interface ApiError {
  error: { code: string; message: string };
}

export class BriefingApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BriefingApiError";
  }
}

async function parseErrorResponse(response: Response): Promise<never> {
  const body = (await response.json()) as ApiError;
  throw new BriefingApiError(body.error?.code ?? "UNKNOWN_ERROR", body.error?.message ?? "Request failed");
}

export async function getLatestBriefing(briefingType: string, timezone: string): Promise<BriefingIssueDTO | null> {
  const params = new URLSearchParams({ briefingType, timezone });
  const response = await fetch(`/api/briefings/latest?${params.toString()}`);

  if (!response.ok) {
    await parseErrorResponse(response);
  }

  const body = await response.json();
  const parsed = LatestBriefingResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new BriefingApiError("MALFORMED_RESPONSE", "The server returned a response that doesn't match the expected contract.");
  }

  return parsed.data.issue;
}

export async function issueTodaysBriefing(request: IssueBriefingRequest): Promise<IssueBriefingResponse> {
  IssueBriefingRequestSchema.parse(request);

  const response = await fetch("/api/briefings/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    await parseErrorResponse(response);
  }

  const body = await response.json();
  const parsed = IssueBriefingResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new BriefingApiError("MALFORMED_RESPONSE", "The server returned a response that doesn't match the expected contract.");
  }

  return parsed.data;
}
