import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { BriefingApiError, getLatestBriefing, issueTodaysBriefing, type BriefingIssueDTO } from "../../lib/briefingApi";

// Phase 6M: a display surface for briefing issues (6L). Deliberately no
// type picker, no date picker, no historical browsing -- always "the
// latest daily briefing," per the handoff's own out-of-scope list.
const BRIEFING_TYPE = "daily";

function resolveTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// en-CA formats as YYYY-MM-DD -- a standard trick for ISO-shaped dates
// out of Intl.DateTimeFormat without a date-math library.
function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type LoadState = "loading" | "loaded" | "error";

export function OperatorDeckPage() {
  const [timezone] = useState(resolveTimezone);
  const [issue, setIssue] = useState<BriefingIssueDTO | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isIssuing, setIsIssuing] = useState(false);

  const loadLatest = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    try {
      const latest = await getLatestBriefing(BRIEFING_TYPE, timezone);
      setIssue(latest);
      setLoadState("loaded");
    } catch (err) {
      setError(err instanceof BriefingApiError ? err.message : "Failed to reach the deck backend.");
      setLoadState("error");
    }
  }, [timezone]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // Safe to press repeatedly -- issueBriefing()'s own idempotency means a
  // second press for an already-issued day returns the existing result
  // rather than duplicating anything, so no special-casing is needed here
  // for the already-issued case.
  const handleIssue = async () => {
    setIsIssuing(true);
    setError(null);
    try {
      await issueTodaysBriefing({ briefingType: BRIEFING_TYPE, localIssueDate: todayInTimezone(timezone), timezone });
      await loadLatest();
    } catch (err) {
      setError(err instanceof BriefingApiError ? err.message : "Failed to issue today's briefing.");
    } finally {
      setIsIssuing(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-shell-bg">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-accent-cyan/20 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-text-secondary hover:text-accent-cyan-glow">
            &larr; Home
          </Link>
          <div>
            <h1 className="font-heading text-lg font-semibold text-text-primary">Operator Deck</h1>
            <p className="text-xs text-text-secondary">{timezone}</p>
          </div>
        </div>
        <Button onClick={() => void handleIssue()} disabled={isIssuing || loadState === "loading"}>
          {isIssuing ? "Issuing…" : "Issue Today's Briefing"}
        </Button>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-6">
        {error && <ErrorState message={error} />}

        {loadState === "loading" && (
          <p className="text-center text-sm text-text-secondary" aria-live="polite">
            Loading the latest briefing…
          </p>
        )}

        {loadState === "loaded" && issue === null && (
          <EmptyState
            title="No briefing issued yet"
            description={'Press "Issue Today\'s Briefing" to generate the first one for this tenant.'}
          />
        )}

        {loadState === "loaded" && issue !== null && <BriefingIssueView issue={issue} />}
      </section>
    </main>
  );
}

function BriefingIssueView({ issue }: { issue: BriefingIssueDTO }) {
  const firstMoveEntry = issue.entries.find((entry) => entry.id === issue.firstMoveEntryId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-text-secondary">
        <span>
          {issue.briefingType} · {issue.localIssueDate}
        </span>
        <span>{issue.publishedAt ? new Date(issue.publishedAt).toLocaleString() : issue.status}</span>
      </div>

      <Card glow="cyan">
        <p className="font-heading text-sm uppercase tracking-wide text-accent-cyan-glow">First Move</p>
        {firstMoveEntry ? (
          <div className="mt-2">
            <EntryContent entry={firstMoveEntry} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">No first-move candidate today.</p>
        )}
      </Card>

      {issue.laneOrder.map((lane) => {
        const laneEntries = issue.entries.filter((entry) => entry.lane === lane).sort((a, b) => a.rank - b.rank);
        return (
          <section key={lane} className="flex flex-col gap-3">
            <h2 className="font-heading text-base font-semibold text-text-primary">{issue.laneLabels[lane]}</h2>
            {laneEntries.length === 0 ? (
              <p className="text-sm text-text-secondary">Nothing in this lane today.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {laneEntries.map((entry) => {
                  const isFirstMove = entry.id === issue.firstMoveEntryId;
                  return (
                    <Card key={entry.id} glow={isFirstMove ? "cyan" : "none"} className={isFirstMove ? "border-accent-cyan" : ""}>
                      <EntryContent entry={entry} />
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function EntryContent({ entry }: { entry: BriefingIssueDTO["entries"][number] }) {
  return (
    <div className="text-sm">
      <p className="font-medium text-text-primary">
        {entry.title}
        {!entry.newToIssue && <span className="ml-2 text-xs text-accent-violet-glow">carried forward</span>}
      </p>
      {entry.detail && <p className="mt-1 text-text-secondary">{entry.detail}</p>}
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {entry.ageDaysSnapshot !== null && (
          <div>
            <dt className="inline font-medium text-text-primary">Age: </dt>
            <dd className="inline">{entry.ageDaysSnapshot}d</dd>
          </div>
        )}
        {entry.carryCountSnapshot !== null && (
          <div>
            <dt className="inline font-medium text-text-primary">Carried: </dt>
            <dd className="inline">{entry.carryCountSnapshot}×</dd>
          </div>
        )}
        {entry.deferCountSnapshot !== null && (
          <div>
            <dt className="inline font-medium text-text-primary">Deferred: </dt>
            <dd className="inline">{entry.deferCountSnapshot}×</dd>
          </div>
        )}
        {entry.escalationLevelSnapshot !== null && (
          <div>
            <dt className="inline font-medium text-text-primary">Escalation: </dt>
            <dd className="inline">{entry.escalationLevelSnapshot}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
