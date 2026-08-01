import type { BriefingIssueEntry, BriefingEntryLane } from "../schemas/briefingIssue.js";

/**
 * One entry plus the minimal display text needed to render it -- built by
 * issueBriefing.ts directly from the same source rows collectCandidates.ts
 * already fetched (a Directive's title, a WorkOrder's task/intent, an
 * ActionReceipt's type, a MemoryCandidate's content prefix), never a
 * second independent query. This is what makes acceptance criterion 8
 * ("prose is generated from the same records used by the UI, no
 * separate/divergent read path") hold structurally: generateProse() takes
 * no PoolClient and makes no query of its own -- it is a pure function
 * over exactly the data issueBriefing.ts already assembled to build the
 * persisted entry rows.
 */
export interface RenderableEntry {
  entry: BriefingIssueEntry;
  title: string;
  detail: string | null;
}

export interface ProseContext {
  briefingType: string;
  localIssueDate: string;
  timezone: string;
  sinceTimestamp: string;
}

// Exported so any other backend code that needs to render/group by lane --
// currently src/http/routes/briefings.ts (6M) -- reuses this one set of
// labels/ordering instead of defining a second one. packages/contracts
// must never import this (backend-internal module); the route resolves
// these server-side and ships the resolved strings/order in the response.
export const LANE_HEADINGS: Record<BriefingEntryLane, string> = {
  decision: "Decisions Required",
  focus: "Focus",
  action: "Actions",
  blocker: "Blocked or Held",
  watch: "Watch — No Action",
  completed: "Completed Since Last Issue",
  evidence: "Evidence Summary",
};

export const LANE_ORDER: BriefingEntryLane[] = ["decision", "focus", "action", "blocker", "watch", "completed", "evidence"];

function renderEntryLine(renderable: RenderableEntry): string {
  const carriedNote = renderable.entry.new_to_issue ? "" : " _(carried forward)_";
  const detail = renderable.detail ? ` — ${renderable.detail}` : "";
  return `- **${renderable.title}**${detail}${carriedNote}`;
}

function renderLaneSection(lane: BriefingEntryLane, renderables: RenderableEntry[]): string {
  const heading = `## ${LANE_HEADINGS[lane]}`;
  const active = renderables.filter((r) => r.entry.lane === lane && r.entry.entry_status === "active");
  if (active.length === 0) {
    return `${heading}\n\n_Nothing in this lane today._`;
  }
  const sorted = [...active].sort((a, b) => a.entry.rank - b.entry.rank);
  return `${heading}\n\n${sorted.map(renderEntryLine).join("\n")}`;
}

/**
 * Generates the Markdown prose for one issue. Pure function -- same
 * inputs always produce the same output, no DB access, no randomness, no
 * wall-clock read of its own (the "now" that matters, sinceTimestamp, is
 * passed in already-resolved).
 */
export function generateProse(context: ProseContext, renderables: readonly RenderableEntry[], firstMove: RenderableEntry | null): string {
  const sections: string[] = [];

  sections.push(
    `# Briefing — ${context.briefingType} — ${context.localIssueDate} (${context.timezone})\n\n` +
      `_Completed/evidence sections reflect activity since ${context.sinceTimestamp}._`,
  );

  sections.push("## First Move");
  sections.push(firstMove ? renderEntryLine(firstMove) : "_No first-move candidate today._");

  for (const lane of LANE_ORDER) {
    sections.push(renderLaneSection(lane, [...renderables]));
  }

  const carried = renderables.filter((r) => !r.entry.new_to_issue && r.entry.entry_status === "active");
  sections.push("## Carried Forward");
  sections.push(
    carried.length === 0
      ? "_Nothing carried forward from a prior issue._"
      : carried.map((r) => `- **${r.title}** _(${LANE_HEADINGS[r.entry.lane]})_`).join("\n"),
  );

  return sections.join("\n\n") + "\n";
}
