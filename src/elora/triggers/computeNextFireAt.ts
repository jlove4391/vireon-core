import { CronExpressionParser } from "cron-parser";
import type { ScheduleKind } from "../../schemas/scheduledTrigger.js";
import { InvalidScheduleExpressionError } from "./errors.js";

// A deliberately narrow subset of ISO 8601 durations -- PnYnMnDTnHnMnS,
// no week designator. Matches the shape 6I's own tests already used
// ("P1D"). Hand-rolled rather than a new dependency: unlike cron-expression
// math (leap years, DST, day-of-week logic -- genuinely worth a library),
// adding a fixed duration to a Date is plain arithmetic.
const ISO8601_DURATION_PATTERN =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

function addIso8601Duration(from: Date, durationExpression: string): Date {
  const trimmed = durationExpression.trim();
  const match = ISO8601_DURATION_PATTERN.exec(trimmed);
  if (!match || trimmed === "P") {
    throw new InvalidScheduleExpressionError(durationExpression, "interval");
  }
  const [, years, months, days, hours, minutes, seconds] = match;
  const next = new Date(from.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + Number(years ?? 0));
  next.setUTCMonth(next.getUTCMonth() + Number(months ?? 0));
  next.setUTCDate(next.getUTCDate() + Number(days ?? 0));
  next.setUTCHours(next.getUTCHours() + Number(hours ?? 0));
  next.setUTCMinutes(next.getUTCMinutes() + Number(minutes ?? 0));
  next.setUTCSeconds(next.getUTCSeconds() + Number(seconds ?? 0));
  return next;
}

export interface ComputeNextFireAtInput {
  scheduleKind: ScheduleKind;
  scheduleExpression: string;
  timezone?: string | null;
  /**
   * The reference point "next" is computed from. At creation time, this is
   * the creation timestamp (first future occurrence). After a successful
   * fire, this is the occurrence that just fired (the trigger's own prior
   * next_fire_at, NOT wall-clock now()) -- computing from the schedule's
   * own last occurrence, not from whenever the poller happened to run,
   * avoids drift and is what "next" means for a recurring schedule.
   */
  from: Date;
}

/**
 * Computes the next scheduled fire time. Returns null only when the
 * caller should treat the trigger as having no further occurrences --
 * callers handle a fired one_off's post-fire transition to null
 * separately (see fireDueTrigger.ts), so this function's one_off branch is
 * only ever exercised for the *initial* next_fire_at at creation time.
 */
export function computeNextFireAt(input: ComputeNextFireAtInput): Date {
  switch (input.scheduleKind) {
    case "one_off": {
      const parsed = new Date(input.scheduleExpression);
      if (Number.isNaN(parsed.getTime())) {
        throw new InvalidScheduleExpressionError(input.scheduleExpression, "one_off");
      }
      return parsed;
    }
    case "interval": {
      return addIso8601Duration(input.from, input.scheduleExpression);
    }
    case "cron": {
      let expression;
      try {
        expression = CronExpressionParser.parse(input.scheduleExpression, {
          currentDate: input.from,
          tz: input.timezone ?? "UTC",
        });
      } catch {
        throw new InvalidScheduleExpressionError(input.scheduleExpression, "cron");
      }
      return expression.next().toDate();
    }
  }
}
