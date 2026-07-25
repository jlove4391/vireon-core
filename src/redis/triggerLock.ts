import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

// Only releases when the stored token still matches this acquisition's own
// token (core-runtime.md §15.2) -- a lock that outlived its owner (e.g.
// released late, after expiry, by a slow process) must never delete a
// different attempt's lock.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface AcquiredTriggerFiringLock {
  key: string;
  token: string;
}

export function buildTriggerFiringLockKey(tenantId: string, triggerId: string, occurrenceTimestamp: string): string {
  return `trigger-firing-lock:${tenantId}:${triggerId}:${occurrenceTimestamp}`;
}

/**
 * Short-lived mutation lock, core-runtime.md §15.1-§15.3: unique token per
 * acquisition, mandatory TTL (a lock without one can deadlock the runtime
 * after a crash). This is a concurrency fast-path only, preventing two
 * poller cycles/processes from processing the same due
 * (tenant, trigger, occurrence) simultaneously -- it is NOT the durable
 * idempotency guarantee. Redis is not durable state (§15.5): the actual
 * correctness backstop is the stable per-trigger thread_id + deterministic
 * sourceCorrelationId, which makes createWorkOrder()'s own existing
 * idempotency-key derivation land on the same key across retries even if
 * this lock is never acquired at all (e.g. Redis briefly unavailable).
 */
export async function acquireTriggerFiringLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<AcquiredTriggerFiringLock | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? { key, token } : null;
}

export async function releaseTriggerFiringLock(redis: Redis, lock: AcquiredTriggerFiringLock): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
}
