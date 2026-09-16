import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  fetchWaasProfile,
  type ProfileExperience,
  type WaasProfile,
} from "./profile-client.js";

export type AuditFinding = {
  id?: number;
  company?: string;
  title?: string;
  severity: "high" | "medium" | "low";
  reason: string;
};

export type SuggestedOrderEntry = {
  id: number;
  company: string;
  title: string;
  score: number;
  rationale: string[];
};

export type ProfileAudit = {
  profileId: number;
  fullName: string;
  fetchedAt: string;
  summary: {
    experienceCount: number;
    currentFlags: number;
    skillsCount: number;
    highSeverity: number;
    mediumSeverity: number;
  };
  gaps: AuditFinding[];
  wrong_dates: AuditFinding[];
  demote_or_remove: AuditFinding[];
  suggested_order: SuggestedOrderEntry[];
  share_notes: AuditFinding[];
  skills_notes: AuditFinding[];
  sources: { kind: "live_profile" | "resume_or_checklist"; path?: string }[];
};

export type AuditProfileInput = {
  /** Optional local resume / checklist / markdown draft to compare against. */
  source_paths?: string[];
  /** Extra company/project names that should appear on the profile. */
  expect?: string[];
};

const WEAK_NAME_PATTERNS = [
  /child\s*wasting/i,
  /second\s*earth/i,
  /self[-\s]?employed/i,
];

const STRONG_SIGNAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "AI/ML research lab", pattern: /\b(lab|research assistant|genomics|pytorch|tensor)\b/i },
  { label: "RAG / agentic AI shipping", pattern: /\b(rag|agentic|chatbot|llm|claude|openai)\b/i },
  { label: "founder / co-founder", pattern: /\b(co-?founder|founded|startup)\b/i },
  { label: "quantified ML project", pattern: /\b(\d+%|accuracy|resnet|cnn|model)\b/i },
  { label: "shipped product with users", pattern: /\b(\d[\d,]+\+?\s*(users|downloads)|chrome extension|production)\b/i },
];

export function parseExpectedNamesFromText(text: string): string[] {
  const names = new Set<string>();
  let inRemoveSection = false;
  let inExperienceSection = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("```")) continue;

    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, "");
      if (/remove|demote|verdict|education|share|skills|preferences|after you paste/i.test(heading)) {
        inRemoveSection = /remove|demote/i.test(heading);
        inExperienceSection = false;
        continue;
      }
      if (/suggested experience|experience order|target experience/i.test(heading)) {
        inExperienceSection = true;
        inRemoveSection = false;
        continue;
      }
    }

    if (inRemoveSection) continue;

    // Numbered experience headings: ### 1. Wells Fargo — Chief Data Office Intern
    const numbered = line.match(/^#{1,6}\s*\d+\.\s*(.+?)(?:\s+[—–-]\s+.+)?$/);
    if (numbered?.[1]) {
      const name = cleanExpectName(numbered[1]);
      if (name) names.add(name);
      continue;
    }

    // Optional N: TarHeelRatings — ...
    const optional = line.match(/^#{1,6}\s*optional\s+\d+\s*(?:\([^)]*\))?\s*[:.]?\s*(.+?)(?:\s+[—–-]\s+.+)?$/i);
    if (optional?.[1]) {
      const name = cleanExpectName(optional[1]);
      if (name) names.add(name);
      continue;
    }

    if (inExperienceSection) {
      const dash = line.match(/^([A-Z][^—–\-]{1,80}?)\s+[—–-]\s+.+/);
      if (dash?.[1] && dash[1].split(/\s+/).length <= 12) {
        const name = cleanExpectName(dash[1]);
        if (name) names.add(name);
      }
    }
  }

  return [...names];
}

function cleanExpectName(value: string): string | null {
  const cleaned = value
    .replace(/\*\*/g, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/^optional\s+\d+\s*(?:\([^)]*\))?\s*[:.]?\s*/i, "")
    .replace(/\s+\((?:optional|independent project).*?\)/i, "")
    .trim();
  if (cleaned.length < 3 || cleaned.length > 90) return null;
  if (
    /^(from|to|location|paste|target|updated|live|remove|education|share|skills|verdict|role|after|waas)\b/i.test(
      cleaned,
    )
  ) {
    return null;
  }
  return cleaned;
}

export function scoreExperience(exp: ProfileExperience): SuggestedOrderEntry {
  const blob = `${exp.company} ${exp.title} ${exp.summary ?? ""}`;
  let score = 0;
  const rationale: string[] = [];

  if (/\b(intern|internship)\b/i.test(blob) && /\b(well|bank|enterprise|fortune)\b/i.test(blob)) {
    score += 25;
    rationale.push("strong internship / enterprise signal");
  }
  if (/\b(research|lab)\b/i.test(blob)) {
    score += 22;
    rationale.push("research signal");
  }
  if (/\b(co-?founder|founded)\b/i.test(blob)) {
    score += 20;
    rationale.push("founder signal");
  }
  if (/\b(rag|llm|chatbot|agentic|pytorch|cnn|ml|machine learning|ai)\b/i.test(blob)) {
    score += 18;
    rationale.push("AI/ML shipping signal");
  }
  if (/\d+%|\d[\d,]*\+|\$\d|\d{2,}\s*(users|employees|neighborhoods)/i.test(blob)) {
    score += 12;
    rationale.push("quantified impact");
  }
  if ((exp.summary?.length ?? 0) >= 180) {
    score += 6;
    rationale.push("detailed summary");
  }
  if (exp.currentlyWorkHere) {
    score += 4;
    rationale.push("marked current");
  }
  if (WEAK_NAME_PATTERNS.some((p) => p.test(blob))) {
    score -= 30;
    rationale.push("matches weak-entry pattern");
  }
  if ((exp.summary?.length ?? 0) < 40) {
    score -= 8;
    rationale.push("thin summary");
  }

  return {
    id: exp.id,
    company: exp.company,
    title: exp.title,
    score,
    rationale,
  };
}

export function auditProfileData(
  profile: WaasProfile,
  options: { expectedNames?: string[]; sourcePaths?: string[] } = {},
): ProfileAudit {
  const gaps: AuditFinding[] = [];
  const wrong_dates: AuditFinding[] = [];
  const demote_or_remove: AuditFinding[] = [];
  const share_notes: AuditFinding[] = [];
  const skills_notes: AuditFinding[] = [];

  const now = new Date();
  const currentFlags = profile.experience.filter((e) => e.currentlyWorkHere).length;

  for (const exp of profile.experience) {
    const start = parseMonth(exp.startDate);
    const end = parseMonth(exp.endDate);

    if (start && end && end < start) {
      wrong_dates.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "high",
        reason: `end_date (${exp.endDate}) is before start_date (${exp.startDate}).`,
      });
    }

    if (exp.currentlyWorkHere && exp.endDate) {
      wrong_dates.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "high",
        reason: `Marked currently work here but end_date is set (${exp.endDate}).`,
      });
    }

    if (!exp.currentlyWorkHere && !exp.endDate && start) {
      wrong_dates.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "medium",
        reason: "No end_date and not marked current — date range is ambiguous.",
      });
    }

    if (exp.currentlyWorkHere && end && end < startOfMonth(now)) {
      wrong_dates.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "high",
        reason: `Marked current but end_date ${exp.endDate} is in the past.`,
      });
    }

    if (start && start > addMonths(startOfMonth(now), 2) && !exp.currentlyWorkHere) {
      wrong_dates.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "medium",
        reason: `start_date ${exp.startDate} is more than 2 months in the future.`,
      });
    }

    const blob = `${exp.company} ${exp.title} ${exp.summary ?? ""}`;
    if (WEAK_NAME_PATTERNS.some((p) => p.test(blob))) {
      demote_or_remove.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "high",
        reason: "Matches known weak / odd labeling pattern (demote or rename).",
      });
    } else if ((exp.summary?.length ?? 0) < 60 && !/\d/.test(exp.summary ?? "")) {
      demote_or_remove.push({
        id: exp.id,
        company: exp.company,
        title: exp.title,
        severity: "medium",
        reason: "Thin summary with no quantified signal — consider demoting or rewriting.",
      });
    }
  }

  if (currentFlags >= 5) {
    wrong_dates.push({
      severity: "high",
      reason: `${currentFlags} entries marked “I currently work here” — usually too many; uncheck ended projects.`,
    });
  } else if (currentFlags >= 4) {
    wrong_dates.push({
      severity: "medium",
      reason: `${currentFlags} current flags — double-check ended roles aren’t still checked.`,
    });
  }

  const profileBlob = [
    ...profile.experience.map((e) => `${e.company} ${e.title} ${e.summary ?? ""}`),
    profile.share.shortPhrase ?? "",
    profile.share.lookingFor ?? "",
    profile.share.proudProject ?? "",
  ].join("\n");

  for (const signal of STRONG_SIGNAL_PATTERNS) {
    if (!signal.pattern.test(profileBlob)) {
      gaps.push({
        severity: "medium",
        reason: `Missing ${signal.label} signal across experience/share copy.`,
      });
    }
  }

  for (const expected of options.expectedNames ?? []) {
    if (!profileHasName(profile, expected)) {
      gaps.push({
        company: expected,
        severity: "high",
        reason: `Expected “${expected}” from resume/checklist but not found on live profile.`,
      });
    }
  }

  if (!profile.share.shortPhrase?.trim()) {
    share_notes.push({ severity: "high", reason: "short_phrase is empty." });
  } else if (profile.share.shortPhrase.trim().length < 40) {
    share_notes.push({ severity: "medium", reason: "short_phrase is short (<40 chars)." });
  }
  if (!profile.share.lookingFor?.trim()) {
    share_notes.push({ severity: "high", reason: "looking_for is empty." });
  }
  if (!profile.share.proudProject?.trim()) {
    share_notes.push({ severity: "medium", reason: "proud_project is empty." });
  }

  if (profile.skills.length === 0) {
    skills_notes.push({ severity: "high", reason: "No top skills set." });
  } else if (profile.skills.length < 5) {
    skills_notes.push({
      severity: "medium",
      reason: `Only ${profile.skills.length} skills — YC profiles usually fill closer to 10.`,
    });
  }
  if (profile.skills.filter((s) => s.rating === "advanced").length === 0 && profile.skills.length > 0) {
    skills_notes.push({
      severity: "low",
      reason: "No skills marked advanced — consider highlighting strongest stack.",
    });
  }

  if (!profile.personal.github) {
    gaps.push({ severity: "medium", reason: "GitHub URL missing on profile." });
  }

  const edu = profile.education[0];
  if (edu?.endDate) {
    const end = parseMonth(edu.endDate);
    if (end && end < startOfMonth(now) && profile.preferences.inSchool === "yes") {
      wrong_dates.push({
        id: edu.id,
        company: edu.school,
        severity: "medium",
        reason: `Education end_date ${edu.endDate} is past but preferences still say in school.`,
      });
    }
  }

  const suggested_order = [...profile.experience]
    .map(scoreExperience)
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));

  const highSeverity = countSeverity(
    [...gaps, ...wrong_dates, ...demote_or_remove, ...share_notes, ...skills_notes],
    "high",
  );
  const mediumSeverity = countSeverity(
    [...gaps, ...wrong_dates, ...demote_or_remove, ...share_notes, ...skills_notes],
    "medium",
  );

  return {
    profileId: profile.profileId,
    fullName: profile.fullName,
    fetchedAt: profile.fetchedAt,
    summary: {
      experienceCount: profile.experience.length,
      currentFlags,
      skillsCount: profile.skills.length,
      highSeverity,
      mediumSeverity,
    },
    gaps,
    wrong_dates,
    demote_or_remove,
    suggested_order,
    share_notes,
    skills_notes,
    sources: [
      { kind: "live_profile" },
      ...(options.sourcePaths ?? []).map((path) => ({ kind: "resume_or_checklist" as const, path })),
    ],
  };
}

export async function auditWaasProfile(input: AuditProfileInput = {}): Promise<ProfileAudit> {
  const profile = await fetchWaasProfile();
  const sourcePaths = input.source_paths ?? [];
  const expectedNames = new Set<string>(input.expect ?? []);

  for (const path of sourcePaths) {
    if (!existsSync(path)) {
      throw new Error(`source_paths entry not found: ${path}`);
    }
    const text = await readFile(path, "utf8");
    for (const name of parseExpectedNamesFromText(text)) {
      expectedNames.add(name);
    }
  }

  return auditProfileData(profile, {
    expectedNames: [...expectedNames],
    sourcePaths,
  });
}

function profileHasName(profile: WaasProfile, expected: string): boolean {
  const needle = normalizeName(expected);
  if (!needle) return true;
  const haystacks = profile.experience.flatMap((e) => [e.company, e.title, e.summary ?? ""]);
  return haystacks.some((h) => {
    const hay = normalizeName(h);
    return hay.includes(needle) || needle.includes(hay) || tokenOverlap(needle, hay) >= 0.6;
  });
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const aTokens = new Set(a.split(" ").filter((t) => t.length > 2));
  const bTokens = new Set(b.split(" ").filter((t) => t.length > 2));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let hit = 0;
  for (const t of aTokens) if (bTokens.has(t)) hit += 1;
  return hit / Math.max(aTokens.size, bTokens.size);
}

function parseMonth(value: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function countSeverity(findings: AuditFinding[], severity: AuditFinding["severity"]): number {
  return findings.filter((f) => f.severity === severity).length;
}
