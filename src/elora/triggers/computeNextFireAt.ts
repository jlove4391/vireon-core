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

/** The last day-of-month (1-31) for the given UTC year/monthIndex, leap-year aware. */
function lastDayOfUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addIso8601Duration(from: Date, durationExpression: string): Date {
  const trimmed = durationExpression.trim();
  const match = ISO8601_DURATION_PATTERN.exec(trimmed);
  if (!match || trimmed === "P") {
    throw new InvalidScheduleExpressionError(durationExpression, "interval");
  }
  const [, years, months, days, hours, minutes, seconds] = match;
  const next = new Date(from.getTime());

  const yearDelta = Number(years ?? 0);
  const monthDelta = Number(months ?? 0);
  if (yearDelta !== 0 || monthDelta !== 0) {
    // Resolution rule for a day-of-month that doesn't exist in the target
    // month (e.g. Jan 31 + P1M): clamp to that month's own last day (Feb
    // 28/29), rather than letting Date's native setUTCMonth day-overflow
    // rollover silently skip into the following month (Jan 31 -> "Feb 31"
    // -> normalizes to Mar 3, which is not "one month later" by any
    // reasonable reading). Reset the day to 1 before shifting year/month
    // so that rollover can never happen in the first place, then clamp
    // the *original* day against the actual target month's length.
    const originalDay = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCFullYear(next.getUTCFullYear() + yearDelta);
    next.setUTCMonth(next.getUTCMonth() + monthDelta);
    next.setUTCDate(Math.min(originalDay, lastDayOfUtcMonth(next.getUTCFullYear(), next.getUTCMonth())));
  }

  next.setUTCDate(next.getUTCDate() + Number(days ?? 0));
  next.setUTCHours(next.getUTCHours() + Number(hours ?? 0));
  next.setUTCMinutes(next.getUTCMinutes() + Number(minutes ?? 0));
  next.setUTCSeconds(next.getUTCSeconds() + Number(seconds ?? 0));
  return next;
}

export interface ComputeNextFireAtInput {
  scheduleKind: ScheduleKind;
  scheduleExpression: string;
  /**
   * Consulted only for scheduleKind === "cron" (wall-clock-local
   * recurrence, e.g. "8am every day in America/New_York" genuinely means
   * a different UTC instant depending on DST). scheduleKind === "interval"
   * deliberately ignores this field: an interval is a fixed elapsed-time
   * span (Y/M/D calendar-arithmetic, H/M/S clock-arithmetic), computed
   * entirely in UTC regardless of the trigger's own timezone -- by design,
   * not by omission. A trigger that needs "same local wall-clock time each
   * day, DST-adjusted" should use scheduleKind = "cron" instead.
   */
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
      // input.timezone is intentionally not consulted here -- see the
      // doc comment on ComputeNextFireAtInput.timezone.
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
