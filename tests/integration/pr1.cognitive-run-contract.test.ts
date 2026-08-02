import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createCognitiveRun } from "../../src/cognition/createCognitiveRun.js";
import { CognitiveRunNotFoundError, InvalidCognitiveRunTransitionError, TerminalCognitiveRunStateError } from "../../src/cognition/errors.js";
import { transitionCognitiveRun, transitionCognitiveRunForTest } from "../../src/cognition/transitionCognitiveRun.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

const OBJECTIVE_KIND = "pr1_lifecycle_fixture";

async function newCognitiveRun(ctx: SeededContext, objectiveKind = OBJECTIVE_KIND) {
  return createCognitiveRun({
    tenantId: ctx.tenantId,
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    initiatedByActorId: ctx.actorId,
    objectiveKind,
  });
}

describe("PR 1: durable cognitive run contract acceptance", () => {
  let ctx: SeededContext;
  let happyPathRunId: string;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("createCognitiveRun() produces a PENDING CognitiveRun and its initial NULL -> PENDING transition row", async () => {
    const { cognitiveRun, initialTransition } = await newCognitiveRun(ctx);
    happyPathRunId = cognitiveRun.id;

    expect(cognitiveRun.status).toBe("PENDING");
    expect(cognitiveRun.tenant_id).toBe(ctx.tenantId);
    expect(cognitiveRun.started_at).toBeNull();
    expect(cognitiveRun.ended_at).toBeNull();
    expect(initialTransition.from_state).toBeNull();
    expect(initialTransition.to_state).toBe("PENDING");
    expect(initialTransition.cognitive_run_id).toBe(cognitiveRun.id);
    expect(initialTransition.tenant_id).toBe(ctx.tenantId);
  });

  it("insert-or-fetches on a retried createCognitiveRun() call with the same idempotency inputs, without duplicating the initial transition row", async () => {
    const first = await newCognitiveRun(ctx, "pr1_idempotent_create_fixture");
    const second = await newCognitiveRun(ctx, "pr1_idempotent_create_fixture");

    expect(second.cognitiveRun.id).toBe(first.cognitiveRun.id);
    expect(second.initialTransition.id).toBe(first.initialTransition.id);

    const countResult = await withTenantTransaction(ctx.tenantId, async (client) =>
      client.query(
        "SELECT count(*) FROM cognitive_run_transitions WHERE cognitive_run_id = $1 AND from_state IS NULL",
        [first.cognitiveRun.id],
      ),
    );
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("walks PENDING -> RUNNING -> COMPLETED, setting started_at/ended_at only on the correct transitions", async () => {
    const running = await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: happyPathRunId,
      nextStatus: "RUNNING",
      actorId: ctx.actorId,
      reason: "cognition began",
    });
    expect(running.cognitiveRun.status).toBe("RUNNING");
    expect(running.cognitiveRun.started_at).not.toBeNull();
    expect(running.cognitiveRun.ended_at).toBeNull();
    expect(running.transition.from_state).toBe("PENDING");
    expect(running.transition.to_state).toBe("RUNNING");

    const completed = await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: happyPathRunId,
      nextStatus: "COMPLETED",
      actorId: ctx.actorId,
      reason: "cognition finished",
    });
    expect(completed.cognitiveRun.status).toBe("COMPLETED");
    expect(completed.cognitiveRun.started_at).toBe(running.cognitiveRun.started_at);
    expect(completed.cognitiveRun.ended_at).not.toBeNull();
    expect(completed.transition.from_state).toBe("RUNNING");
    expect(completed.transition.to_state).toBe("COMPLETED");
  });

  it("reaches FAILED from RUNNING, setting ended_at (never completed_at -- there is no such column)", async () => {
    const { cognitiveRun } = await newCognitiveRun(ctx, "pr1_failed_fixture");
    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "RUNNING",
      actorId: ctx.actorId,
      reason: "began",
    });
    const failed = await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "FAILED",
      actorId: ctx.actorId,
      reason: "forced failure",
    });
    expect(failed.cognitiveRun.status).toBe("FAILED");
    expect(failed.cognitiveRun.ended_at).not.toBeNull();
  });

  it("reaches CANCELLED directly from PENDING", async () => {
    const { cognitiveRun } = await newCognitiveRun(ctx, "pr1_cancelled_from_pending_fixture");
    const cancelled = await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "CANCELLED",
      actorId: ctx.actorId,
      reason: "cancelled before it started",
    });
    expect(cancelled.cognitiveRun.status).toBe("CANCELLED");
    expect(cancelled.cognitiveRun.started_at).toBeNull();
    expect(cancelled.cognitiveRun.ended_at).not.toBeNull();
  });

  it("reaches CANCELLED from RUNNING", async () => {
    const { cognitiveRun } = await newCognitiveRun(ctx, "pr1_cancelled_from_running_fixture");
    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "RUNNING",
      actorId: ctx.actorId,
      reason: "began",
    });
    const cancelled = await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "CANCELLED",
      actorId: ctx.actorId,
      reason: "cancelled mid-flight",
    });
    expect(cancelled.cognitiveRun.status).toBe("CANCELLED");
    expect(cancelled.cognitiveRun.started_at).not.toBeNull();
    expect(cancelled.cognitiveRun.ended_at).not.toBeNull();
  });

  it("rejects an unlisted transition with InvalidCognitiveRunTransitionError", async () => {
    const { cognitiveRun } = await newCognitiveRun(ctx, "pr1_invalid_transition_fixture");

    await expect(
      transitionCognitiveRun({
        tenantId: ctx.tenantId,
        cognitiveRunId: cognitiveRun.id,
        nextStatus: "COMPLETED",
        actorId: ctx.actorId,
        reason: "invalid skip-ahead attempt",
      }),
    ).rejects.toBeInstanceOf(InvalidCognitiveRunTransitionError);
  });

  it("blocks further transitions from all three terminal states identically", async () => {
    // COMPLETED, reached by the happy path run.
    await expect(
      transitionCognitiveRun({
        tenantId: ctx.tenantId,
        cognitiveRunId: happyPathRunId,
        nextStatus: "RUNNING",
        actorId: ctx.actorId,
        reason: "attempt to mutate a completed CognitiveRun",
      }),
    ).rejects.toBeInstanceOf(TerminalCognitiveRunStateError);

    // FAILED.
    const failedRun = await newCognitiveRun(ctx, "pr1_terminal_failed_fixture");
    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: failedRun.cognitiveRun.id,
      nextStatus: "RUNNING",
      actorId: ctx.actorId,
      reason: "began",
    });
    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: failedRun.cognitiveRun.id,
      nextStatus: "FAILED",
      actorId: ctx.actorId,
      reason: "forced failure",
    });
    await expect(
      transitionCognitiveRun({
        tenantId: ctx.tenantId,
        cognitiveRunId: failedRun.cognitiveRun.id,
        nextStatus: "RUNNING",
        actorId: ctx.actorId,
        reason: "attempt to mutate a failed CognitiveRun",
      }),
    ).rejects.toBeInstanceOf(TerminalCognitiveRunStateError);

    // CANCELLED.
    const cancelledRun = await newCognitiveRun(ctx, "pr1_terminal_cancelled_fixture");
    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cancelledRun.cognitiveRun.id,
      nextStatus: "CANCELLED",
      actorId: ctx.actorId,
      reason: "cancelled",
    });
    await expect(
      transitionCognitiveRun({
        tenantId: ctx.tenantId,
        cognitiveRunId: cancelledRun.cognitiveRun.id,
        nextStatus: "RUNNING",
        actorId: ctx.actorId,
        reason: "attempt to mutate a cancelled CognitiveRun",
      }),
    ).rejects.toBeInstanceOf(TerminalCognitiveRunStateError);
  });

  it("rolls back status and transition history on a forced mid-transaction failure", async () => {
    const { cognitiveRun } = await newCognitiveRun(ctx, "pr1_rollback_fixture");

    await expect(
      transitionCognitiveRunForTest({
        tenantId: ctx.tenantId,
        cognitiveRunId: cognitiveRun.id,
        nextStatus: "RUNNING",
        actorId: ctx.actorId,
        reason: "forced rollback probe",
      }),
    ).rejects.toThrow("test-only failure injection");

    const { runRow, transitionRows } = await withTenantTransaction(ctx.tenantId, async (client) => {
      const run = await client.query("SELECT * FROM cognitive_runs WHERE id = $1", [cognitiveRun.id]);
      const transitions = await client.query(
        "SELECT * FROM cognitive_run_transitions WHERE cognitive_run_id = $1 ORDER BY created_at ASC",
        [cognitiveRun.id],
      );
      return { runRow: run.rows[0], transitionRows: transitions.rows };
    });

    expect(runRow.status).toBe("PENDING");
    expect(runRow.started_at).toBeNull();
    expect(transitionRows).toHaveLength(1);
    expect(transitionRows[0].to_state).toBe("PENDING");
  });

  it("self-rejects a retried transition targeting the already-current status, without duplicating a row", async () => {
    const { cognitiveRun } = await newCognitiveRun(ctx, "pr1_idempotent_retry_fixture");

    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "RUNNING",
      actorId: ctx.actorId,
      reason: "first attempt",
    });

    await expect(
      transitionCognitiveRun({
        tenantId: ctx.tenantId,
        cognitiveRunId: cognitiveRun.id,
        nextStatus: "RUNNING",
        actorId: ctx.actorId,
        reason: "retried attempt",
      }),
    ).rejects.toBeInstanceOf(InvalidCognitiveRunTransitionError);

    const countResult = await withTenantTransaction(ctx.tenantId, async (client) =>
      client.query(
        "SELECT count(*) FROM cognitive_run_transitions WHERE cognitive_run_id = $1 AND to_state = 'RUNNING'",
        [cognitiveRun.id],
      ),
    );
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("rejects a cross-tenant CognitiveRun reference with CognitiveRunNotFoundError", async () => {
    const tenantB = await seedBaseContext();

    await expect(
      transitionCognitiveRun({
        tenantId: tenantB.tenantId,
        cognitiveRunId: happyPathRunId,
        nextStatus: "RUNNING",
        actorId: tenantB.actorId,
        reason: "cross-tenant attempt",
      }),
    ).rejects.toBeInstanceOf(CognitiveRunNotFoundError);
  });

  it("enforces row-level security on cognitive_runs and cognitive_run_transitions", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const unsetRuns = await client.query("SELECT id FROM cognitive_runs WHERE id = $1", [happyPathRunId]);
      expect(unsetRuns.rows).toHaveLength(0);
      const unsetTransitions = await client.query(
        "SELECT id FROM cognitive_run_transitions WHERE cognitive_run_id = $1",
        [happyPathRunId],
      );
      expect(unsetTransitions.rows).toHaveLength(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const otherTenantId = randomUUID();
    const wrongTenantRuns = await withTenantTransaction(otherTenantId, async (txClient) =>
      txClient.query("SELECT id FROM cognitive_runs WHERE id = $1", [happyPathRunId]),
    );
    expect(wrongTenantRuns.rows).toHaveLength(0);
    const wrongTenantTransitions = await withTenantTransaction(otherTenantId, async (txClient) =>
      txClient.query("SELECT id FROM cognitive_run_transitions WHERE cognitive_run_id = $1", [happyPathRunId]),
    );
    expect(wrongTenantTransitions.rows).toHaveLength(0);

    const correctTenantRuns = await withTenantTransaction(ctx.tenantId, async (txClient) =>
      txClient.query("SELECT id FROM cognitive_runs WHERE id = $1", [happyPathRunId]),
    );
    expect(correctTenantRuns.rows.length).toBeGreaterThan(0);
    const correctTenantTransitions = await withTenantTransaction(ctx.tenantId, async (txClient) =>
      txClient.query("SELECT id FROM cognitive_run_transitions WHERE cognitive_run_id = $1", [happyPathRunId]),
    );
    expect(correctTenantTransitions.rows.length).toBeGreaterThan(0);
  });

  it("confirms every transition row for the happy path shares tenant_id with the CognitiveRun", async () => {
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const transitions = await client.query(
        "SELECT tenant_id FROM cognitive_run_transitions WHERE cognitive_run_id = $1",
        [happyPathRunId],
      );
      return transitions.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(ctx.tenantId);
    }
  });
});
