import "dotenv/config";
import { pollAllTenantsOnce } from "../src/elora/triggers/fireDueTriggers.js";
import { createRedisClient } from "../src/redis/client.js";

// Ground-zero runner (core-runtime.md §3): a simple, inspectable
// synchronous loop, same "prefer simple local routing" posture as
// src/http/server.ts -- not a queue/worker framework.
const POLL_INTERVAL_MS = Number(process.env.TRIGGER_POLL_INTERVAL_MS ?? 30_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const redis = createRedisClient();
  await redis.connect();

  // eslint-disable-next-line no-console
  console.log(`Trigger poller started. Poll interval: ${POLL_INTERVAL_MS}ms.`);

  for (;;) {
    try {
      const outcomes = await pollAllTenantsOnce(redis);
      if (outcomes.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`Poll cycle: ${outcomes.length} due trigger(s) processed.`, outcomes);
      }
    } catch (error) {
      // A single failed poll cycle must not crash the process -- the next
      // cycle retries safely (next_fire_at only advances on a successful
      // fire, so nothing due is ever silently lost to a transient error).
      // eslint-disable-next-line no-console
      console.error("Trigger poller cycle failed:", error);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Trigger poller crashed:", error);
  process.exitCode = 1;
});
