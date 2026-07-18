// Phase 6A §7: thin client for the one route this phase adds. No mocked
// data, no client-side reconstruction of anything the server response
// already carries -- the response is passed through as-is.
//
// Phase 6E: the request/response shapes are no longer hand-mirrored here --
// they're imported from the shared @vireon/contracts package, and the
// response is genuinely validated at runtime (EloraMessageResponseSchema.safeParse),
// not just trusted via an unchecked type assertion.

import {
  EloraMessageResponseSchema,
  type EloraMessageResponse,
  type SendEloraMessageRequest,
} from "@vireon/contracts";

export type { EloraMessageResponse, SendEloraMessageRequest };

export interface ApiError {
  error: { code: string; message: string };
}

export class EloraApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EloraApiError";
  }
}

export async function sendEloraMessage(request: SendEloraMessageRequest): Promise<EloraMessageResponse> {
  const response = await fetch("/api/elora/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const body = await response.json();

  if (!response.ok) {
    const errorBody = body as ApiError;
    throw new EloraApiError(errorBody.error?.code ?? "UNKNOWN_ERROR", errorBody.error?.message ?? "Request failed");
  }

  const parsed = EloraMessageResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new EloraApiError(
      "MALFORMED_RESPONSE",
      "The server returned a response that doesn't match the expected contract.",
    );
  }

  return parsed.data;
}
