import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { APPLIED_PATH, ensureDataDir } from "./config.js";

export type AppliedRecord = {
  jobId: string;
  company: string;
  title: string;
  appliedAt: string;
  dryRun?: boolean;
};

export function loadApplied(): AppliedRecord[] {
  ensureDataDir();
  if (!existsSync(APPLIED_PATH)) return [];
  return JSON.parse(readFileSync(APPLIED_PATH, "utf8")) as AppliedRecord[];
}

export function markApplied(record: AppliedRecord): void {
  ensureDataDir();
  const existing = loadApplied().filter((r) => r.jobId !== record.jobId);
  existing.push(record);
  writeFileSync(APPLIED_PATH, JSON.stringify(existing, null, 2));
}

export function isTrackedApplied(jobId: string): boolean {
  return loadApplied().some((r) => r.jobId === jobId && !r.dryRun);
}
