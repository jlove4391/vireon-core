import { describe, expect, it } from "vitest";
import { createRedisClient } from "../../src/redis/client.js";

describe("Phase 1: Redis connectivity", () => {
  it("connects, receives PONG for PING, and closes cleanly", async () => {
    const client = createRedisClient();

    await client.connect();
    try {
      const response = await client.ping();
      expect(response).toBe("PONG");
    } finally {
      await client.quit();
    }
  });
});
