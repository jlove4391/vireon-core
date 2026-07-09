import { z } from "zod";

export const uuidSchema = z.string().uuid();

export function buildIdempotencyKey(parts: (string | number)[]): string {
  return parts.map((part) => String(part)).join(":");
}
