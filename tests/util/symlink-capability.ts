/**
 * Probes whether this process can create real filesystem symlinks.
 *
 * On Windows this needs Developer Mode (or admin elevation) and fails
 * otherwise; junctions don't need the privilege but can't stand in for a
 * symlink when a test is exercising symlink-specific semantics (a symlink to
 * a file, a dangling target, `lstat().isSymbolicLink()` on a leaf). Those
 * tests should skip via `it.skipIf(!canCreateSymlinks())` rather than a
 * blanket `process.platform === "win32"` check, so they still run on
 * Windows machines (including CI) that do have the privilege.
 */

import { symlinkSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached: boolean | undefined;

export function canCreateSymlinks(): boolean {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), "ctx-symlink-probe-"));
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "");
    symlinkSync(target, link);
    cached = true;
  } catch {
    cached = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
