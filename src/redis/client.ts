import "dotenv/config";
import { Redis } from "ioredis";

/**
 * Thin ioredis client wrapper. Phase 1's only obligation is proving Redis is
 * reachable -- lock acquisition, TTL handling, and Redis's functional role
 * from core-runtime.md 15 begin in a later phase.
 */
export function createRedisClient(): Redis {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL is not set");
  }

  return new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
}
