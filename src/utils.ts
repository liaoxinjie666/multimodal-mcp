/**
 * Shared utilities for all providers.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Output directory for all generated / parsed files. */
export const OUTPUT_DIR =
  process.env.OUTPUT_DIR ?? join(process.cwd(), "generated");

let outputDirEnsured = false;

/** Ensure OUTPUT_DIR exists. Safe to call multiple times; only runs mkdir once. */
export async function ensureOutputDir(): Promise<void> {
  if (outputDirEnsured) return;
  await mkdir(OUTPUT_DIR, { recursive: true });
  outputDirEnsured = true;
}

/**
 * Generate a timestamped filename: `{prefix}_{YYYYMMDDHHmmss}.{ext}`
 */
export function tsFilename(prefix: string, ext: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  return `${prefix}_${ts}.${ext}`;
}

/** Write a buffer to OUTPUT_DIR and return the absolute path. */
export async function writeToOutputDir(
  filename: string,
  data: Buffer,
): Promise<{ outPath: string; size_bytes: number }> {
  await ensureOutputDir();
  const outPath = join(OUTPUT_DIR, filename);
  await writeFile(outPath, data);
  return { outPath, size_bytes: data.length };
}
