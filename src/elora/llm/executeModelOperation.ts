import { createHash, randomUUID } from "node:crypto";
import type { ZodSchema } from "zod";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { setCorrelationAttributes, withSpan } from "../../telemetry/correlation.js";
import { decideContentPolicy, evaluateModelInput } from "./contentPolicy/evaluateModelInput.js";
import { redactModelInput } from "./contentPolicy/redactModelInput.js";
import type { ModelDataClassification, SensitiveField } from "./contentPolicy/types.js";
import {
  ModelOperationError,
  ModelOperationInvalidOutputError,
  ModelOperationPersistenceError,
  ModelOperationProviderFailureError,
  ModelOperationTimeoutError,
  type ModelOperationErrorKind,
} from "./errors.js";
import type { LlmProvider, ProviderOperationCallResult, ProviderUsage } from "./types.js";

// PR 2: the six operations this table's CHECK constraint (migrations/0014)
// enumerates -- closed, not open-vocabulary, since the full set is fully
// known right now.
export const MODEL_OPERATION_KINDS = [
  "response_synthesis",
  "intent_interpretation",
  "planning",
  "critique",
  "extraction",
  "reranking",
] as const;
export type ModelOperationKind = (typeof MODEL_OPERATION_KINDS)[number];

/**
 * `source` is only ever "MODEL" from this executor -- it never applies a
 * fallback itself. "DETERMINISTIC_FALLBACK" is synthesized only by
 * operations/responseSynthesis.ts's own run() wrapper on top of an ok:false
 * result from this function, per the locked decision that only response
 * synthesis gets a legitimate production fallback; every other operation's
 * run() wrapper passes this function's result straight through unchanged.
 *
 * invocationId is optional on the failure branch specifically because a
 * PERSISTENCE_FAILURE at the very first write (the STARTED row insert
 * itself) means no row was ever created to reference -- and, as of PR 3, a
 * SENSITIVE_CONTEXT_BLOCKED failure never has one either: the content-policy
 * boundary runs before insertStartedRow, so a denied request is never
 * recorded as an external model invocation, because no provider call ever
 * occurred.
 */
export type ModelOperationResult<T> =
  | { ok: true; value: T; source: "MODEL" | "DETERMINISTIC_FALLBACK"; invocationId: string }
  | { ok: false; error: { kind: ModelOperationErrorKind; retryable: boolean }; invocationId?: string };

/** Shared shape every operations/*.ts run() wrapper's options extend -- avoids six near-identical option interfaces. */
export interface RunOperationOptions {
  tenantId: string;
  /** PR 1's cognitive_runs id, when this call happens inside a real cognitive run. No live caller supplies this yet. */
  cognitiveRunId?: string | null;
  provider: LlmProvider;
  /** Identifies the logical request; paired with attemptNumber to give each physical retry its own durable row. */
  invocationKey: string;
  attemptNumber?: number;
  timeoutMs?: number;
  /** PR 3: content-policy config. Omit entirely for INTERNAL/allowed/no-redaction behavior -- zero change for existing callers. */
  contentPolicy?: ContentPolicyConfig;
}

/** Generous for a real round trip, matching generateEloraResponse.ts's own LLM_TIMEOUT_MS. Each operation's run() may override via options.timeoutMs. */
export const DEFAULT_MODEL_OPERATION_TIMEOUT_MS = 30_000;

// PR 3: providers approved to receive CONFIDENTIAL-classified content by
// default. Env-configurable (MODEL_POLICY_APPROVED_PROVIDERS, comma-separated),
// a single global setting -- per-tenant policy needs durable tenant config,
// RLS, admin authorization, and audit, which is a genuinely separate, later
// PR, not a small addition to this one.
function defaultApprovedProvidersForConfidential(): readonly string[] {
  const raw = process.env.MODEL_POLICY_APPROVED_PROVIDERS;
  if (!raw) {
    return ["anthropic", "openai"];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// PR 3: this process's own configured provider secrets -- defense-in-depth
// against a request accidentally echoing them back at a provider. Read
// lazily (not at module load) so tests that mutate process.env mid-run
// still get current values.
function configuredProviderSecrets(): string[] {
  return [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY].filter((value): value is string => Boolean(value));
}

export interface ContentPolicyConfig {
  declaredFields?: SensitiveField[];
  approvedProvidersForConfidential?: readonly string[];
  restrictedAllowed?: boolean;
}

export interface ExecuteModelOperationConfig<TInput, TOutput> {
  tenantId: string;
  /** PR 1's cognitive_runs id, when this call happens inside a real cognitive run. No live caller supplies this yet. */
  cognitiveRunId?: string | null;
  operationKind: ModelOperationKind;
  operationVersion?: number;
  inputSchemaVersion?: number;
  outputSchemaVersion?: number;
  /** Identifies the logical request; paired with attemptNumber to give each physical retry its own durable row (migrations/0014's own doctrine). */
  invocationKey: string;
  attemptNumber?: number;
  provider: LlmProvider;
  input: TInput;
  /** May be a function of the input -- e.g. reranking.ts builds a schema that rejects unknown/duplicate candidate ids specific to the candidates actually supplied for this call. */
  outputSchema: ZodSchema<TOutput> | ((input: TInput) => ZodSchema<TOutput>);
  callProvider: (provider: LlmProvider, input: TInput, timeoutMs: number) => Promise<ProviderOperationCallResult>;
  timeoutMs: number;
  /** PR 3: content-policy config. Omit entirely for INTERNAL/allowed/no-redaction behavior -- zero change for existing callers. */
  contentPolicy?: ContentPolicyConfig;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Races `promise` against its own timer, independent of whatever the
 * provider does internally. This is what makes TIMEOUT classification
 * deterministic and provider-agnostic -- it never depends on guessing a
 * specific SDK's timeout error shape. The provider is still separately
 * given `timeoutMs` (see each operation's callProvider) so a
 * timeout-aware SDK call also aborts its own in-flight request; this race
 * is what guarantees the executor itself never waits past `timeoutMs`
 * regardless of whether the provider honors that.
 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, operationKind: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelOperationTimeoutError(operationKind, timeoutMs)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function insertStartedRow(
  config: Pick<
    ExecuteModelOperationConfig<unknown, unknown>,
    "tenantId" | "cognitiveRunId" | "operationKind" | "invocationKey" | "provider"
  >,
  meta: {
    operationVersion: number;
    inputSchemaVersion: number;
    outputSchemaVersion: number;
    attemptNumber: number;
    requestFingerprint: string;
    inputPolicyVersion: number;
    inputClassification: ModelDataClassification;
    redactionApplied: boolean;
    redactionCount: number;
  },
): Promise<string> {
  try {
    return await withTenantTransaction(config.tenantId, async (client) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO model_invocations
           (id, tenant_id, cognitive_run_id, operation_kind, operation_version, input_schema_version,
            output_schema_version, provider, model, status, invocation_key, attempt_number,
            provider_usage, request_fingerprint, started_at, created_at,
            input_policy_version, input_classification, redaction_applied, redaction_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'STARTED',$10,$11,'{}'::jsonb,$12,$13,$13,$14,$15,$16,$17)`,
        [
          id,
          config.tenantId,
          config.cognitiveRunId ?? null,
          config.operationKind,
          meta.operationVersion,
          meta.inputSchemaVersion,
          meta.outputSchemaVersion,
          config.provider.providerId,
          config.provider.modelId,
          config.invocationKey,
          meta.attemptNumber,
          meta.requestFingerprint,
          now,
          meta.inputPolicyVersion,
          meta.inputClassification,
          meta.redactionApplied,
          meta.redactionCount,
        ],
      );
      return id;
    });
  } catch (error) {
    throw new ModelOperationPersistenceError(config.operationKind, error);
  }
}

interface TerminalFields {
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT";
  durationMs: number;
  responseFingerprint: string | null;
  usage?: ProviderUsage | null;
  errorClass?: string | null;
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  resolvedModel?: string | null;
}

async function markTerminal(tenantId: string, invocationId: string, fields: TerminalFields): Promise<void> {
  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `UPDATE model_invocations
       SET status = $1, completed_at = $2, duration_ms = $3, response_fingerprint = $4,
           input_tokens = $5, output_tokens = $6, cache_creation_input_tokens = $7,
           cache_read_input_tokens = $8, provider_usage = $9, error_class = $10,
           provider_request_id = $11, provider_response_id = $12, resolved_model = $13
       WHERE id = $14 AND tenant_id = $15`,
      [
        fields.status,
        new Date().toISOString(),
        fields.durationMs,
        fields.responseFingerprint,
        fields.usage?.inputTokens ?? null,
        fields.usage?.outputTokens ?? null,
        fields.usage?.cacheCreationInputTokens ?? null,
        fields.usage?.cacheReadInputTokens ?? null,
        JSON.stringify(fields.usage?.raw ?? {}),
        fields.errorClass ?? null,
        fields.providerRequestId ?? null,
        fields.providerResponseId ?? null,
        fields.resolvedModel ?? null,
        invocationId,
        tenantId,
      ],
    );
  });
}

/**
 * The one shared write-path function every operation's run() wrapper goes
 * through, mirroring src/directives/appendDirectiveRevision.ts's/
 * addDirectiveProvenance.ts's "one shared write-path function, reused by
 * every caller" pattern: runs the content-policy boundary, inserts the
 * STARTED row, opens a PR 0 span, invokes the provider under a
 * deterministic timeout, validates the response through the operation's
 * Zod schema, records usage/provider metadata, marks the terminal status,
 * and returns a typed result. Each of the six operation files supplies
 * only operation-specific config -- none of them re-implement this
 * lifecycle themselves.
 */
export async function executeModelOperation<TInput, TOutput>(
  config: ExecuteModelOperationConfig<TInput, TOutput>,
): Promise<ModelOperationResult<TOutput>> {
  const operationVersion = config.operationVersion ?? 1;
  const inputSchemaVersion = config.inputSchemaVersion ?? 1;
  const outputSchemaVersion = config.outputSchemaVersion ?? 1;
  const attemptNumber = config.attemptNumber ?? 1;

  return withSpan(
    "elora.llm",
    `model_operation.${config.operationKind}`,
    {
      "vireon.tenant.id": config.tenantId,
      "vireon.model_operation.kind": config.operationKind,
      "vireon.model_operation.provider": config.provider.providerId,
    },
    async (span) => {
      if (config.cognitiveRunId) {
        setCorrelationAttributes(span, { cognitiveRunId: config.cognitiveRunId });
      }

      // PR 3: content-policy boundary -- runs before insertStartedRow. A
      // policy-denied request must never be recorded as an external model
      // invocation, because no provider call occurred: no row, a trace
      // event instead.
      const declaredFields = config.contentPolicy?.declaredFields ?? [];
      const classifiedInput = evaluateModelInput({
        serializedContent: JSON.stringify(config.input),
        declaredFields,
        configuredSecrets: configuredProviderSecrets(),
      });
      const policyDecision = decideContentPolicy({
        classifiedInput,
        targetProvider: config.provider.providerId,
        approvedProvidersForConfidential: config.contentPolicy?.approvedProvidersForConfidential ?? defaultApprovedProvidersForConfidential(),
        restrictedAllowed: config.contentPolicy?.restrictedAllowed,
      });

      if (!policyDecision.allowed) {
        span.addEvent("content_policy.blocked", {
          "vireon.model_operation.input_classification": policyDecision.classification,
          "vireon.model_operation.policy_reason": policyDecision.reason,
        });
        return { ok: false, error: { kind: "SENSITIVE_CONTEXT_BLOCKED", retryable: false } };
      }

      const redactionResult = policyDecision.redactionNeeded ? redactModelInput(config.input, declaredFields) : null;
      const effectiveInput = redactionResult?.redacted ?? config.input;
      const redactionApplied = redactionResult !== null && redactionResult.redactionCount > 0;
      const redactionCount = redactionResult?.redactionCount ?? 0;

      // If a request was redacted, fingerprint the redacted version, not
      // the original -- never persist the original unredacted input.
      const requestFingerprint = fingerprint(effectiveInput);

      let invocationId: string;
      try {
        invocationId = await insertStartedRow(config, {
          operationVersion,
          inputSchemaVersion,
          outputSchemaVersion,
          attemptNumber,
          requestFingerprint,
          inputPolicyVersion: 1,
          inputClassification: policyDecision.classification,
          redactionApplied,
          redactionCount,
        });
      } catch {
        // STARTED insert itself failed -- no row was ever created, so
        // invocationId is genuinely absent, not merely omitted.
        return { ok: false, error: { kind: "PERSISTENCE_FAILURE", retryable: true } };
      }
      span.setAttribute("vireon.model_invocation.id", invocationId);
      span.setAttribute("vireon.model_operation.input_classification", policyDecision.classification);

      const startedAtMs = Date.now();

      try {
        const callResult = await raceWithTimeout(
          config.callProvider(config.provider, effectiveInput, config.timeoutMs),
          config.timeoutMs,
          config.operationKind,
        );

        let parsedOutput: TOutput;
        try {
          const resolvedSchema =
            typeof config.outputSchema === "function" ? config.outputSchema(effectiveInput) : config.outputSchema;
          const parseResult = resolvedSchema.safeParse(callResult.output);
          if (!parseResult.success) {
            throw parseResult.error;
          }
          parsedOutput = parseResult.data;
        } catch (validationError) {
          throw new ModelOperationInvalidOutputError(config.operationKind, validationError);
        }

        const durationMs = Date.now() - startedAtMs;
        const responseFingerprint = fingerprint(parsedOutput);

        try {
          await markTerminal(config.tenantId, invocationId, {
            status: "SUCCEEDED",
            durationMs,
            responseFingerprint,
            usage: callResult.usage,
            providerRequestId: callResult.providerRequestId,
            providerResponseId: callResult.providerResponseId,
            resolvedModel: callResult.resolvedModel,
          });
        } catch (persistError) {
          throw new ModelOperationPersistenceError(config.operationKind, persistError);
        }

        span.setAttribute("vireon.model_invocation.status", "SUCCEEDED");
        return { ok: true, value: parsedOutput, source: "MODEL", invocationId };
      } catch (error) {
        const durationMs = Date.now() - startedAtMs;

        // A PERSISTENCE_FAILURE here means the terminal write itself just
        // failed -- the invocation row is real (invocationId is genuinely
        // known) but stays observably STARTED, which is exactly what
        // idx_model_invocations_incomplete exists to surface, rather than
        // this function trying (and risking failing) a second write.
        if (error instanceof ModelOperationPersistenceError) {
          span.setAttribute("vireon.model_invocation.status", "PERSISTENCE_FAILURE");
          return { ok: false, error: { kind: "PERSISTENCE_FAILURE", retryable: true }, invocationId };
        }

        const classified: ModelOperationError =
          error instanceof ModelOperationError ? error : new ModelOperationProviderFailureError(config.operationKind, error);

        try {
          await markTerminal(config.tenantId, invocationId, {
            status: classified.kind === "TIMEOUT" ? "TIMED_OUT" : "FAILED",
            durationMs,
            responseFingerprint: null,
            errorClass: errorClassName(error),
          });
        } catch {
          // Best-effort: the row just stays observable as stale-STARTED
          // instead. invocationId below is still real and already known.
        }

        span.setAttribute("vireon.model_invocation.status", classified.kind === "TIMEOUT" ? "TIMED_OUT" : "FAILED");
        return { ok: false, error: { kind: classified.kind, retryable: classified.retryable }, invocationId };
      }
    },
  );
}
