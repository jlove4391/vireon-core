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

// Phase 6F §6: a live model call takes real seconds where everything before
// it has been near-instant. This AbortController is a client-side backstop,
// set longer than the server's own ~30s LLM timeout so the server's timeout
// and deterministic fallback fire first in the normal case -- this only
// trips if the whole request (not just the LLM call) genuinely hangs.
const CLIENT_TIMEOUT_MS = 40_000;

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("/api/elora/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new EloraApiError("REQUEST_TIMEOUT", "The request took too long to respond.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

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
