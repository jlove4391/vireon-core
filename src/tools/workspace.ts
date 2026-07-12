import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WorkspaceBoundaryViolationError } from "./errors.js";

// Phase 5 §7: bounded workspace contract. Genuinely new code -- no prior
// filesystem-boundary infrastructure existed in the repo before this file.

const DEFAULT_MAX_BYTES = 1_000_000; // 1MB -- generous for local Markdown notes, small enough to bound abuse.

export interface WorkspaceConfig {
  baseRoot: string;
  maxBytes: number;
}

/** Reads ELORA_WORKSPACE_ROOT / ELORA_WORKSPACE_MAX_BYTES, with safe local-dev defaults. Not a secret, so unlike DATABASE_URL this does not throw when unset. */
export function loadWorkspaceConfig(): WorkspaceConfig {
  const baseRoot = process.env.ELORA_WORKSPACE_ROOT
    ? path.resolve(process.env.ELORA_WORKSPACE_ROOT)
    : path.resolve(process.cwd(), "data", "elora-workspace");
  const maxBytes = process.env.ELORA_WORKSPACE_MAX_BYTES
    ? Number(process.env.ELORA_WORKSPACE_MAX_BYTES)
    : DEFAULT_MAX_BYTES;
  return { baseRoot, maxBytes };
}

/** Tenant/workspace-scoped subdirectory under the configured base root (§7). */
export function resolveWorkspaceRoot(config: WorkspaceConfig, tenantId: string, workspaceId: string | null | undefined): string {
  return path.join(config.baseRoot, tenantId, workspaceId ?? "_no_workspace");
}

export async function ensureWorkspaceRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
}

function validateRelativePath(relativePath: string): void {
  if (relativePath.length === 0) {
    throw new WorkspaceBoundaryViolationError("EMPTY_PATH", "relative path must not be empty");
  }
  if (relativePath.includes("\0")) {
    throw new WorkspaceBoundaryViolationError("NULL_BYTE", "relative path contains a null byte");
  }
  // Windows drive-letter / UNC escapes, checked explicitly rather than
  // relying solely on path.isAbsolute -- its behavior is platform-dependent
  // (path.posix.isAbsolute("C:\\foo") is false), so an attack shaped for
  // the other platform could otherwise slip through depending on which OS
  // this happens to run on.
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new WorkspaceBoundaryViolationError("DRIVE_LETTER_PATH", "relative path must not include a drive letter");
  }
  if (/^\\\\/.test(relativePath) || /^\/\//.test(relativePath)) {
    throw new WorkspaceBoundaryViolationError("UNC_PATH", "relative path must not be a UNC path");
  }
  if (path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new WorkspaceBoundaryViolationError("ABSOLUTE_PATH", "relative path must not be absolute");
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceBoundaryViolationError("PATH_TRAVERSAL", "relative path must not contain '..' segments");
  }
}

/**
 * Path-segment-aware containment check -- a naive string-prefix check is
 * not sufficient (`/workspace-root-evil` would pass a prefix check against
 * `/workspace-root`). Appending path.sep to both sides before comparing
 * closes that gap.
 */
export function resolveContainedPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new WorkspaceBoundaryViolationError("PATH_ESCAPE", "resolved path escapes the workspace root");
  }
  return resolvedTarget;
}

/**
 * Symlink-escape protection: realpath()s the deepest existing ancestor of
 * the target (the target itself for reads, since it must already exist; a
 * parent directory for writes to a not-yet-existing file) and re-checks
 * containment against the workspace root's own real path -- catching a
 * symlink inside the workspace that points outside it, which a purely
 * lexical check would miss.
 */
async function assertRealpathContained(root: string, targetPath: string): Promise<void> {
  const realRoot = await fs.realpath(path.resolve(root));
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  let current = targetPath;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await fs.realpath(current);
      const realWithSep = real.endsWith(path.sep) ? real : real + path.sep;
      if (real !== realRoot && !realWithSep.startsWith(realRootWithSep)) {
        throw new WorkspaceBoundaryViolationError("SYMLINK_ESCAPE", "resolved real path escapes the workspace root");
      }
      return;
    } catch (error) {
      if (error instanceof WorkspaceBoundaryViolationError) {
        throw error;
      }
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) {
          return; // reached filesystem root without finding an existing ancestor -- nothing to symlink-check
        }
        current = parent;
        continue;
      }
      throw error;
    }
  }
}

export interface ReadWorkspaceFileResult {
  relativePath: string;
  content: string;
  byteCount: number;
  contentHash: string;
}

/** core.local_file.read's underlying service (§11.1): UTF-8 text, regular files only, bounded by maxBytes. */
export async function readWorkspaceFile(
  config: WorkspaceConfig,
  root: string,
  relativePath: string,
): Promise<ReadWorkspaceFileResult> {
  validateRelativePath(relativePath);
  const targetPath = resolveContainedPath(root, relativePath);
  await assertRealpathContained(root, targetPath);

  const stat = await fs.stat(targetPath).catch(() => {
    throw new WorkspaceBoundaryViolationError("NOT_FOUND", `no such file: ${relativePath}`);
  });
  if (!stat.isFile()) {
    throw new WorkspaceBoundaryViolationError("NOT_A_REGULAR_FILE", `not a regular file: ${relativePath}`);
  }
  if (stat.size > config.maxBytes) {
    throw new WorkspaceBoundaryViolationError(
      "CONTENT_TOO_LARGE",
      `file size ${stat.size} exceeds the configured limit of ${config.maxBytes} bytes`,
    );
  }

  const buffer = await fs.readFile(targetPath);
  const content = buffer.toString("utf8");
  return {
    relativePath,
    content,
    byteCount: buffer.byteLength,
    contentHash: createHash("sha256").update(buffer).digest("hex"),
  };
}

export interface WriteWorkspaceFileResult {
  relativePath: string;
  byteCount: number;
  contentHash: string;
  created: boolean;
  overwritten: boolean;
}

/** core.local_file.write's underlying service (§11.2): UTF-8 content, controlled directory creation, explicit overwrite behavior, bounded by maxBytes. */
export async function writeWorkspaceFile(
  config: WorkspaceConfig,
  root: string,
  relativePath: string,
  content: string,
  options: { allowOverwrite: boolean },
): Promise<WriteWorkspaceFileResult> {
  validateRelativePath(relativePath);
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength > config.maxBytes) {
    throw new WorkspaceBoundaryViolationError(
      "CONTENT_TOO_LARGE",
      `content size ${buffer.byteLength} exceeds the configured limit of ${config.maxBytes} bytes`,
    );
  }

  const targetPath = resolveContainedPath(root, relativePath);
  await assertRealpathContained(root, targetPath);

  const existed = await fs
    .stat(targetPath)
    .then((stat) => {
      if (!stat.isFile()) {
        throw new WorkspaceBoundaryViolationError("NOT_A_REGULAR_FILE", `not a regular file: ${relativePath}`);
      }
      return true;
    })
    .catch((error) => {
      if (error instanceof WorkspaceBoundaryViolationError) {
        throw error;
      }
      return false;
    });

  if (existed && !options.allowOverwrite) {
    throw new WorkspaceBoundaryViolationError("ALREADY_EXISTS", `refusing to overwrite existing file: ${relativePath}`);
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  // Atomic write where practical: write to a sibling temp file, then rename.
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, buffer);
  await fs.rename(tempPath, targetPath);

  return {
    relativePath,
    byteCount: buffer.byteLength,
    contentHash: createHash("sha256").update(buffer).digest("hex"),
    created: !existed,
    overwritten: existed,
  };
}

/** Best-effort cleanup of a partially-written file if a downstream step (e.g. DB persistence) fails after the write succeeded. */
export async function removeWorkspaceFileQuietly(targetAbsolutePath: string): Promise<void> {
  await fs.unlink(targetAbsolutePath).catch(() => undefined);
}
