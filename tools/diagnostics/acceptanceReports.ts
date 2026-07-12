import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface AcceptanceReportSummary {
  file: string;
  phase: string;
  status: string;
  timestamp: string;
}

const CORE_RECORDS_DIR = path.resolve(process.cwd(), "core-records");

/**
 * Lists core-records/*.json with a one-line summary each. File-based --
 * no database access, no tenant context. Phase identity is read from the
 * filename (each report is named `<phase>-...-acceptance.json`) rather than
 * assumed from report content, since Phase 1's and Phase 2's report shapes
 * are not identical beyond `status`/`timestamp`.
 */
export function listAcceptanceReports(): AcceptanceReportSummary[] {
  let filenames: string[];
  try {
    filenames = readdirSync(CORE_RECORDS_DIR).filter((filename) => filename.endsWith(".json"));
  } catch {
    return [];
  }

  return filenames.sort().map((filename) => {
    const raw = readFileSync(path.join(CORE_RECORDS_DIR, filename), "utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    return {
      file: filename,
      phase: filename.replace(/-acceptance\.json$/, ""),
      status: typeof parsed.status === "string" ? parsed.status : "unknown",
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "unknown",
    };
  });
}
