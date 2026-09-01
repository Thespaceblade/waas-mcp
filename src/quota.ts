import { readFileSync } from "node:fs";
import { resolveSessionCookie } from "./waas.js";

export const DEFAULT_WEEKLY_CAP = Number(process.env.WAAS_WEEKLY_CAP ?? 10);

export type WaasConversation = {
  id: string;
  has_applied?: boolean;
  last_active_at?: string;
  referenced_job_ids?: number[];
  company?: { id?: number; name?: string };
  applied_job_title?: string | null;
  messages?: {
    id?: number;
    from_candidate?: boolean;
    created_at?: string;
    message?: string;
  }[];
};

export type WeeklyApplication = {
  company: string;
  companyId: number | null;
  jobIds: number[];
  appliedAt: string;
  conversationId: string;
};

export type WeeklyQuotaStatus = {
  cap: number;
  used: number;
  remaining: number;
  atLimit: boolean;
  weekStart: string;
  weekResetsAt: string;
  source: "conversations_api";
  applicationsThisWeek: WeeklyApplication[];
  message: string;
  applyBlockedReason: string | null;
};

export function weekStartMonday(reference = new Date()): Date {
  const d = new Date(reference);
  const day = d.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - daysFromMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function weekResetsAt(weekStart: Date): string {
  const reset = new Date(weekStart);
  reset.setDate(reset.getDate() + 7);
  return reset.toISOString();
}

export function applicationsThisWeek(
  conversations: WaasConversation[],
  reference = new Date(),
): WeeklyApplication[] {
  const weekStart = weekStartMonday(reference);
  const results: WeeklyApplication[] = [];

  for (const conversation of conversations) {
    if (!conversation.has_applied) continue;

    const candidateMessages = (conversation.messages ?? [])
      .filter((message) => message.from_candidate)
      .sort(
        (a, b) =>
          new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
      );

    const appliedAt =
      candidateMessages[0]?.created_at ??
      conversation.last_active_at ??
      null;
    if (!appliedAt || new Date(appliedAt) < weekStart) continue;

    results.push({
      company: conversation.company?.name ?? conversation.id,
      companyId: conversation.company?.id ?? null,
      jobIds: conversation.referenced_job_ids ?? [],
      appliedAt,
      conversationId: conversation.id,
    });
  }

  return results.sort(
    (a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime(),
  );
}

export function buildWeeklyQuotaStatus(
  conversations: WaasConversation[],
  options?: { cap?: number; reference?: Date },
): WeeklyQuotaStatus {
  const cap = options?.cap ?? DEFAULT_WEEKLY_CAP;
  const weekStartDate = weekStartMonday(options?.reference);
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const weekApps = applicationsThisWeek(conversations, options?.reference);
  const used = weekApps.length;
  const remaining = Math.max(0, cap - used);
  const atLimit = used >= cap;

  return {
    cap,
    used,
    remaining,
    atLimit,
    weekStart,
    weekResetsAt: weekResetsAt(weekStartDate),
    source: "conversations_api",
    applicationsThisWeek: weekApps,
    message: atLimit
      ? `Weekly application cap reached (${used}/${cap}). New in-app applications are blocked until ${weekResetsAt(weekStartDate).slice(0, 10)}.`
      : `${remaining} of ${cap} Work at a Startup applications remaining this week (${used} used since ${weekStart}).`,
    applyBlockedReason: atLimit
      ? `Work at a Startup limits you to ${cap} applications per week. You have used ${used} since ${weekStart}.`
      : null,
  };
}

export async function fetchConversations(): Promise<WaasConversation[]> {
  const cookie = await resolveSessionCookie();
  const response = await fetch("https://www.workatastartup.com/api/conversations", {
    headers: {
      cookie,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch WaaS conversations (${response.status}).`);
  }

  return (await response.json()) as WaasConversation[];
}

export async function fetchWeeklyQuotaStatus(): Promise<WeeklyQuotaStatus> {
  const conversations = await fetchConversations();
  return buildWeeklyQuotaStatus(conversations);
}

export const APPLY_LIMIT_PATTERNS = [
  /maximum (number of )?applications/i,
  /applications? per week/i,
  /per week.*applications?/i,
  /this week.*applications?/i,
  /weekly application (limit|cap)/i,
  /reached (your |the )?(weekly )?application (limit|cap)/i,
  /cannot apply (right now|at this time|any more)/i,
  /can't apply (right now|at this time|any more)/i,
  /too many applications/i,
];

export function detectApplyLimitMessage(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  for (const pattern of APPLY_LIMIT_PATTERNS) {
    if (pattern.test(normalized)) {
      const sentence =
        normalized
          .split(/(?<=[.!?])\s+/)
          .find((part) => APPLY_LIMIT_PATTERNS.some((p) => p.test(part))) ?? normalized;
      return sentence.slice(0, 300);
    }
  }

  return null;
}

export function parseApplyErrorBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      message?: string;
      errors?: string[] | Record<string, string[]>;
    };
    const parts = [
      parsed.error,
      parsed.message,
      ...(Array.isArray(parsed.errors) ? parsed.errors : []),
      ...(parsed.errors && !Array.isArray(parsed.errors)
        ? Object.values(parsed.errors).flat()
        : []),
    ].filter(Boolean) as string[];
    const combined = parts.join(" ");
    return detectApplyLimitMessage(combined) ?? (parts[0] ?? null);
  } catch {
    return detectApplyLimitMessage(body);
  }
}

export function loadOptionalQuotaOverride(): Partial<WeeklyQuotaStatus> | null {
  const path = process.env.WAAS_QUOTA_PATH?.trim();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      cap_per_week?: number;
      week_start?: string;
      submitted_this_week?: { company?: string; role?: string; date?: string }[];
    };
    const cap = raw.cap_per_week ?? DEFAULT_WEEKLY_CAP;
    const used = raw.submitted_this_week?.length ?? 0;
    const remaining = Math.max(0, cap - used);
    return {
      cap,
      used,
      remaining,
      atLimit: used >= cap,
      weekStart: raw.week_start ?? weekStartMonday().toISOString().slice(0, 10),
      applicationsThisWeek:
        raw.submitted_this_week?.map((entry, index) => ({
          company: entry.company ?? `manual-${index + 1}`,
          companyId: null,
          jobIds: [],
          appliedAt: entry.date ?? new Date().toISOString(),
          conversationId: `manual:${index + 1}`,
        })) ?? [],
    };
  } catch {
    return null;
  }
}

export function mergeQuotaStatuses(
  primary: WeeklyQuotaStatus,
  override: Partial<WeeklyQuotaStatus> | null,
): WeeklyQuotaStatus {
  if (!override) return primary;
  if ((override.weekStart ?? primary.weekStart) !== primary.weekStart) return primary;

  const cap = override.cap ?? primary.cap;
  const used = Math.max(primary.used, override.used ?? 0);
  const remaining = Math.max(0, cap - used);
  const atLimit = used >= cap;

  return {
    ...primary,
    cap,
    used,
    remaining,
    atLimit,
    message: atLimit
      ? `Weekly application cap reached (${used}/${cap}). New in-app applications are blocked until ${primary.weekResetsAt.slice(0, 10)}.`
      : `${remaining} of ${cap} Work at a Startup applications remaining this week (${used} used since ${primary.weekStart}).`,
    applyBlockedReason: atLimit
      ? `Work at a Startup limits you to ${cap} applications per week. You have used ${used} since ${primary.weekStart}.`
      : null,
  };
}

export async function resolveWeeklyQuotaStatus(): Promise<WeeklyQuotaStatus> {
  const fromApi = await fetchWeeklyQuotaStatus();
  return mergeQuotaStatuses(fromApi, loadOptionalQuotaOverride());
}

export function applyWeeklyQuotaToInspection<
  T extends {
    alreadyApplied: boolean;
    applicationType: string;
    canAutoSubmit: boolean;
    notes: string[];
  },
>(
  inspection: T,
  weeklyQuota: WeeklyQuotaStatus,
  ui?: { limitMessage?: string | null; canSend?: boolean },
): T & { weeklyQuota: WeeklyQuotaStatus; applyBlocked: boolean; applicationType: string } {
  if (inspection.alreadyApplied || inspection.applicationType === "external") {
    return { ...inspection, weeklyQuota, applyBlocked: false };
  }

  const uiBlocked = Boolean(ui?.limitMessage) || ui?.canSend === false;
  const blocked = weeklyQuota.atLimit || uiBlocked;

  if (!blocked) {
    return { ...inspection, weeklyQuota, applyBlocked: false };
  }

  const notes = [...inspection.notes];
  if (!notes.some((note) => note.includes("Weekly application cap"))) {
    notes.push(weeklyQuota.message);
  }
  if (ui?.limitMessage && !notes.includes(ui.limitMessage)) {
    notes.push(ui.limitMessage);
  }

  return {
    ...inspection,
    weeklyQuota,
    applyBlocked: true,
    applicationType: "weekly_limit_reached",
    canAutoSubmit: false,
    notes,
  };
}
