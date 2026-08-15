import { execFileSync } from "node:child_process";

/**
 * Pre-commit guard against core-records/*.json noise. These files are
 * acceptance-report artifacts written by writeFileSync() calls inside the
 * test suite (e.g. tests/integration/phase4.receipts-authority.test.ts's
 * "writes the Phase 4 acceptance report" test) -- running `pnpm test`
 * regenerates ALL of them, every time, regardless of which test file
 * actually changed. Every field that varies between runs (timestamp,
 * tenant_id, every *_id) is random per run; the only field that carries
 * real signal is `status`. Two PRs in a row landed with all six files
 * churned as pure incidental noise from running the suite before
 * committing -- this exists so that stops requiring a human (or Claude) to
 * catch it by hand on every review.
 *
 * Blocks the commit only when a staged core-records/*.json file's content,
 * after stripping every UUID and ISO-8601 timestamp value, is byte-identical
 * to HEAD's version -- i.e. genuinely nothing but re-randomized volatile
 * fields changed. A real content change (status flips, a branch is added
 * or removed, the acceptance criteria shift) always passes through
 * untouched. New files (nothing to diff against) always pass.
 *
 * Escape hatch for the rare deliberate "regenerate every acceptance report"
 * commit: ALLOW_CORE_RECORDS_NOISE=1 git commit ...
 */

const CORE_RECORDS_PATTERN = /^core-records\/.*\.json$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function normalizeVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeVolatileFields);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeVolatileFields(entry);
    }
    return result;
  }
  if (typeof value === "string" && (UUID_PATTERN.test(value) || ISO_TIMESTAMP_PATTERN.test(value))) {
    return "<volatile>";
  }
  return value;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function main(): void {
  if (process.env.ALLOW_CORE_RECORDS_NOISE === "1") {
    return;
  }

  const stagedFiles = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CORE_RECORDS_PATTERN.test(line));

  if (stagedFiles.length === 0) {
    return;
  }

  const noiseOnlyFiles: string[] = [];

  for (const file of stagedFiles) {
    let headContent: string | null = null;
    try {
      headContent = git(["show", `HEAD:${file}`]);
    } catch {
      // New file, nothing to compare against -- always a real change.
      continue;
    }

    let stagedContent: string;
    try {
      stagedContent = git(["show", `:${file}`]);
    } catch {
      continue;
    }

    let headParsed: unknown;
    let stagedParsed: unknown;
    try {
      headParsed = JSON.parse(headContent);
      stagedParsed = JSON.parse(stagedContent);
    } catch {
      // Not parseable as JSON -- don't guess, let it through.
      continue;
    }

    const normalizedHead = JSON.stringify(normalizeVolatileFields(headParsed));
    const normalizedStaged = JSON.stringify(normalizeVolatileFields(stagedParsed));

    if (normalizedHead === normalizedStaged) {
      noiseOnlyFiles.push(file);
    }
  }

  if (noiseOnlyFiles.length === 0) {
    return;
  }

  process.stderr.write(
    [
      "",
      "pre-commit: blocked -- these staged core-records/*.json files only differ",
      "from HEAD by re-randomized timestamps/uuids (test-run regeneration noise,",
      "no real content change):",
      "",
      ...noiseOnlyFiles.map((file) => `  ${file}`),
      "",
      "Unstage them and re-commit:",
      "",
      `  git restore --staged ${noiseOnlyFiles.join(" ")}`,
      "",
      "If you genuinely intend to commit regenerated acceptance reports as-is,",
      "bypass with: ALLOW_CORE_RECORDS_NOISE=1 git commit ...",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

main();
