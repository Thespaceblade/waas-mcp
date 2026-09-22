import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fetchWaasProfile, type WaasProfile } from "./profile-client.js";
import type { UpdateProfileInput } from "./update-profile-client.js";
import { validateShareCopy } from "./update-profile-client.js";

export type DraftExperience = {
  company: string;
  title: string;
  location?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  currently_work_here?: boolean;
  summary?: string | null;
  optional?: boolean;
  matchedLiveId?: number | null;
};

export type DraftEducation = {
  school?: string;
  degree?: string | null;
  field_of_study?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  matchedLiveId?: number | null;
};

export type DraftSkill = {
  name: string;
  rating: "beginner" | "intermediate" | "advanced";
};

export type ParsedProfileDraft = {
  experience: DraftExperience[];
  education: DraftEducation | null;
  share: {
    short_phrase?: string;
    looking_for?: string;
    proud_project?: string;
  };
  skills: DraftSkill[];
  remove: string[];
  notes: string[];
};

export type ProfileDraftResult = {
  sources: { path: string; kind: "optimized_draft" | "resume_or_bank" | "other" }[];
  parsed: ParsedProfileDraft;
  live: {
    experienceCount: number;
    skillsCount: number;
    shortPhrase: string | null;
  } | null;
  /** Ready to pass into waas_update_profile (keep dry_run true until approval). */
  update_payload: UpdateProfileInput;
  suggested_order: { company: string; title: string; optional?: boolean; matchedLiveId?: number | null }[];
  remove_list: string[];
  instructions: string[];
};

const MONTHS: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sep: "09",
  sept: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

export function parseHumanMonth(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\*+/g, "");
  const iso = trimmed.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const named = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = MONTHS[named[1]!.toLowerCase()];
    if (!month) throw new Error(`Unknown month in date "${value}".`);
    return `${named[2]}-${month}`;
  }
  return null;
}

/** Month token only — avoids bare `to` matching inside "October". */
const MONTH_DATE_RE = String.raw`(?:[A-Za-z]+\s+\d{4}|\d{4}-\d{2}(?:-\d{2})?)`;

function applyExperienceFromLine(current: DraftExperience, line: string): boolean {
  if (!/^-?\s*From:/i.test(line)) return false;
  const rest = line.replace(/^-?\s*From:\s*/i, "");

  const range = rest.match(
    new RegExp(
      `^\\*{0,2}(${MONTH_DATE_RE})\\*{0,2}\\s*(?:→|->|\\bto\\b)\\s*(?:To:\\s*)?\\*{0,2}(.+?)\\*{0,2}\\s*(?:\\(|$)`,
      "i",
    ),
  );
  if (range) {
    current.start_date = parseHumanMonth(range[1]);
    const endRaw = range[2]!.trim().replace(/\*+/g, "");
    if (/present|current|now/i.test(endRaw) || /currently work here/i.test(line)) {
      current.currently_work_here = true;
      current.end_date = null;
    } else {
      current.end_date = parseHumanMonth(endRaw);
      current.currently_work_here = false;
    }
    if (/currently work here/i.test(line) && !/do NOT mark current|uncheck current/i.test(line)) {
      current.currently_work_here = true;
      current.end_date = null;
    }
    if (/do NOT mark current|uncheck current/i.test(line)) {
      current.currently_work_here = false;
    }
    if (/check current/i.test(line) && !/uncheck|do NOT/i.test(line)) {
      current.currently_work_here = true;
      current.end_date = null;
    }
    return true;
  }

  const only = rest.match(new RegExp(`^\\*{0,2}(${MONTH_DATE_RE})\\*{0,2}\\s*(.*)$`, "i"));
  if (only) {
    current.start_date = parseHumanMonth(only[1]);
    if (/currently work here/i.test(line) && !/uncheck|do NOT/i.test(line)) {
      current.currently_work_here = true;
      current.end_date = null;
    } else if (/check current/i.test(line) && !/uncheck|do NOT/i.test(line)) {
      current.currently_work_here = true;
      current.end_date = null;
    }
    return true;
  }
  return false;
}

export function parseOptimizedWaasDraft(text: string): ParsedProfileDraft {
  const notes: string[] = [];
  const remove: string[] = [];
  const experience: DraftExperience[] = [];
  let education: DraftEducation | null = null;
  const share: ParsedProfileDraft["share"] = {};
  const skills: DraftSkill[] = [];

  const lines = text.split(/\r?\n/);
  let section: "none" | "experience" | "remove" | "education" | "share" | "skills" = "none";
  let current: DraftExperience | null = null;
  let inPaste = false;
  let pasteLines: string[] = [];

  const flushPaste = () => {
    if (current && pasteLines.length) {
      current.summary = pasteLines.join(" ").replace(/\s+/g, " ").trim();
    }
    pasteLines = [];
    inPaste = false;
  };

  const flushCurrent = () => {
    flushPaste();
    if (current?.company && current.title) {
      experience.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (line.startsWith("```")) {
      if (inPaste) flushPaste();
      else {
        inPaste = true;
        pasteLines = [];
      }
      continue;
    }
    if (inPaste) {
      if (line) pasteLines.push(line);
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, "");
      if (/suggested experience|experience order/i.test(heading)) {
        flushCurrent();
        section = "experience";
        continue;
      }
      if (/remove|demote/i.test(heading)) {
        flushCurrent();
        section = "remove";
        continue;
      }
      if (/^education\b/i.test(heading)) {
        flushCurrent();
        section = "education";
        continue;
      }
      if (/^share\b/i.test(heading)) {
        flushCurrent();
        section = "share";
        continue;
      }
      if (/^skills\b/i.test(heading)) {
        flushCurrent();
        section = "skills";
        continue;
      }
      if (/verdict|after you paste|role|preferences/i.test(heading)) {
        flushCurrent();
        section = "none";
        continue;
      }

      // Experience entry heading
      const optional = /^optional\b/i.test(heading);
      const cleaned = heading
        .replace(/^optional\s+\d+\s*(?:\([^)]*\))?\s*[:.]?\s*/i, "")
        .replace(/^\d+\.\s*/, "")
        .trim();
      const parts = cleaned.split(/\s+[—–-]\s+/);
      if (section === "experience" || /^\d+\./.test(heading) || optional) {
        flushCurrent();
        section = "experience";
        current = {
          company: (parts[0] ?? cleaned).trim(),
          title: (parts.slice(1).join(" — ").trim() || "Independent Project").replace(/\s*\(.*\)\s*$/, "").trim(),
          optional,
          currently_work_here: false,
        };
        continue;
      }
    }

    if (section === "experience" && current) {
      const location = line.match(/^-?\s*Location:\s*(.+)$/i);
      if (location) {
        current.location = location[1]!.replace(/\s*\(.*\)\s*$/, "").trim();
        continue;
      }
      if (applyExperienceFromLine(current, line)) continue;
    }

    if (section === "remove") {
      const bullet = line.match(/^[-*]\s+\*\*(.+?)\*\*/);
      if (bullet?.[1]) remove.push(bullet[1].trim());
      continue;
    }

    if (section === "education") {
      if (!education) education = {};
      if (/university|college|school/i.test(line) && !education.school) {
        education.school = line.replace(/^[-*]\s+/, "").replace(/\*+/g, "").trim();
      } else if (/data science|computer science|bachelor|masters|phd/i.test(line)) {
        const degreeMatch = line.match(/\b(Bachelors?|Masters?|PhD|Associate)\b/i);
        if (degreeMatch) education.degree = degreeMatch[1]!.replace(/s$/i, "s").replace(/^bachelor$/i, "Bachelors");
        if (/data science/i.test(line)) education.field_of_study = "Data Science";
        if (/computer science/i.test(line)) education.field_of_study = "Computer Science";
      } else if (/from:/i.test(line)) {
        const m = line.match(
          new RegExp(
            `From:\\s*\\*{0,2}(${MONTH_DATE_RE})\\*{0,2}\\s*(?:→|->|\\bto\\b)\\s*(?:To:\\s*)?\\*{0,2}(${MONTH_DATE_RE})`,
            "i",
          ),
        );
        if (m) {
          education.start_date = parseHumanMonth(m[1]);
          education.end_date = parseHumanMonth(m[2]);
        }
      }
      continue;
    }

    if (section === "share") {
      if (/^\*\*Short phrase:\*\*/i.test(line) || /^Short phrase:/i.test(line)) {
        share.short_phrase = line.replace(/^\*\*?Short phrase:\*\*?\s*/i, "").trim();
        if (!share.short_phrase && lines[i + 1]?.trim()) {
          share.short_phrase = lines[++i]!.trim();
        }
      } else if (/^\*\*Looking for:\*\*/i.test(line) || /^Looking for:/i.test(line)) {
        share.looking_for = line.replace(/^\*\*?Looking for:\*\*?\s*/i, "").trim();
        if (!share.looking_for && lines[i + 1]?.trim()) {
          share.looking_for = lines[++i]!.trim();
        }
      } else if (/^\*\*Proud project:\*\*/i.test(line) || /^Proud project:/i.test(line)) {
        share.proud_project = line.replace(/^\*\*?Proud project:\*\*?\s*/i, "").trim();
        if (!share.proud_project && lines[i + 1]?.trim()) {
          share.proud_project = lines[++i]!.trim();
        }
      } else if (share.short_phrase === undefined && line && !line.startsWith("#") && !line.startsWith("(")) {
        // continuation lines already handled by peek; skip noise
      }
      continue;
    }

    if (section === "skills") {
      const row = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (row && !/skill/i.test(row[1]!) && !/^-+$/.test(row[1]!.trim())) {
        const ratingRaw = row[2]!.trim().toLowerCase();
        const rating = ratingRaw.startsWith("adv")
          ? "advanced"
          : ratingRaw.startsWith("beg")
            ? "beginner"
            : "intermediate";
        skills.push({ name: row[1]!.trim(), rating });
      }
    }
  }

  flushCurrent();

  if (!experience.length) notes.push("No experience entries parsed from draft.");
  if (!share.short_phrase) notes.push("No short_phrase found in draft.");
  if (!skills.length) notes.push("No skills table found in draft.");

  return { experience, education, share, skills, remove, notes };
}

/** Light extraction from resume banks / tex: company-like headings and itemize bullets. */
export function parseResumeLikeText(text: string): Partial<ParsedProfileDraft> {
  const experience: DraftExperience[] = [];
  const notes: string[] = ["Parsed resume/bank text heuristically — prefer an optimized WAAS markdown draft when available."];

  // \resumeSubheading{Company}{dates}{Title}{location}
  const tex = [
    ...text.matchAll(
      /\\resumeSubheading\s*\{([^{}]+)\}\s*\{([^{}]*)\}\s*\{([^{}]+)\}\s*\{([^{}]*)\}/g,
    ),
  ];
  for (const m of tex) {
    const dates = m[2] ?? "";
    const range = dates.split(/\s*[–—-]\s*/);
    experience.push({
      company: decodeTex(m[1]!),
      title: decodeTex(m[3]!),
      location: decodeTex(m[4] || "") || null,
      start_date: parseHumanMonth(range[0]?.replace(/\$|[{}]/g, "").trim() || null),
      end_date: /present/i.test(dates) ? null : parseHumanMonth(range[1]?.replace(/\$|[{}]/g, "").trim() || null),
      currently_work_here: /present/i.test(dates),
      summary: null,
    });
  }

  // Markdown: ### Company — Title
  if (!tex.length) {
    for (const line of text.split(/\r?\n/)) {
      const md = line.match(/^#{2,3}\s+(.+?)\s+[—–-]\s+(.+)$/);
      if (md) {
        experience.push({
          company: md[1]!.trim(),
          title: md[2]!.trim(),
          summary: null,
        });
      }
    }
  }

  return { experience, notes, remove: [], skills: [], share: {}, education: null };
}

function decodeTex(value: string): string {
  return value
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\{\\/g, "")
    .replace(/\\textbf\{([^{}]+)\}/g, "$1")
    .replace(/\\textit\{([^{}]+)\}/g, "$1")
    .replace(/[{}]/g, "")
    .trim();
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesOverlap(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

export function buildUpdatePayloadFromDraft(
  draft: ParsedProfileDraft,
  live: WaasProfile | null,
  options: { include_optional?: boolean } = {},
): Pick<ProfileDraftResult, "update_payload" | "suggested_order" | "remove_list" | "instructions"> {
  const includeOptional = options.include_optional === true;
  const selected = draft.experience.filter((e) => includeOptional || !e.optional);

  const liveByCompany = live?.experience ?? [];
  const usedIds = new Set<number>();

  const positions = selected.map((entry) => {
    const match = liveByCompany.find(
      (liveExp) => !usedIds.has(liveExp.id) && namesOverlap(liveExp.company, entry.company),
    );
    if (match) usedIds.add(match.id);
    entry.matchedLiveId = match?.id ?? null;
    return {
      ...(match ? { id: match.id } : {}),
      company: entry.company,
      title: entry.title,
      location: entry.location ?? null,
      start_date: entry.start_date ?? null,
      end_date: entry.currently_work_here ? null : (entry.end_date ?? null),
      currently_work_here: Boolean(entry.currently_work_here),
      summary: entry.summary ?? null,
    };
  });

  if (draft.education && live?.education[0]) {
    draft.education.matchedLiveId = live.education[0].id;
  }

  const remove_list = [...draft.remove];
  // Also remove live entries not present in draft (by company) when we have a strong draft
  if (live && selected.length >= 3) {
    for (const liveExp of live.experience) {
      const kept = selected.some((e) => namesOverlap(e.company, liveExp.company));
      if (!kept) remove_list.push(liveExp.company);
    }
  }

  const update_payload: UpdateProfileInput = {
    dry_run: true,
    experience: {
      mode: "replace",
      positions,
      ...(remove_list.length ? { remove_match: [...new Set(remove_list)] } : {}),
    },
  };

  // For replace mode, remove_match isn't applied the same way — put removals in notes via remove_list
  // and rely on replace list. Clear remove_match from replace payload to avoid API confusion.
  if (update_payload.experience) {
    delete update_payload.experience.remove_match;
  }

  if (draft.education) {
    update_payload.education = {
      ...(draft.education.matchedLiveId != null ? { id: draft.education.matchedLiveId } : {}),
      school: draft.education.school,
      degree: draft.education.degree,
      field_of_study: draft.education.field_of_study,
      start_date: draft.education.start_date,
      end_date: draft.education.end_date,
    };
  }

  if (draft.share.short_phrase || draft.share.looking_for || draft.share.proud_project) {
    update_payload.share = { ...draft.share };
  }

  if (draft.skills.length) {
    update_payload.skills = {
      mode: "replace",
      items: draft.skills.slice(0, 10).map((s) => ({ name: s.name, rating: s.rating })),
    };
  }

  const shareWarnings = update_payload.share ? validateShareCopy(update_payload.share) : [];

  return {
    update_payload,
    suggested_order: selected.map((e) => ({
      company: e.company,
      title: e.title,
      optional: e.optional,
      matchedLiveId: e.matchedLiveId,
    })),
    remove_list: [...new Set(remove_list)],
    instructions: [
      "Review update_payload, then call waas_update_profile with the same object (dry_run=true first).",
      "After approval, set dry_run=false.",
      "Then waas_preview_profile / waas_audit_profile to QA.",
      ...(includeOptional ? [] : ["Optional draft experiences were omitted; pass include_optional=true to include them."]),
      ...shareWarnings.map((w) => `Share validation warning: ${w}`),
    ],
  };
}

export type DraftProfileInput = {
  source_paths?: string[];
  include_optional?: boolean;
  /** If false, skip live profile fetch (offline draft only). Default true. */
  compare_live?: boolean;
};

export async function draftWaasProfile(input: DraftProfileInput = {}): Promise<ProfileDraftResult> {
  const paths = input.source_paths ?? [];
  if (!paths.length) {
    throw new Error(
      "Provide source_paths to an optimized WAAS markdown draft and/or resume/bank files (e.g. Jobs/WAAS/waas_profile_optimized_*.md).",
    );
  }

  const sources: ProfileDraftResult["sources"] = [];
  let merged: ParsedProfileDraft = {
    experience: [],
    education: null,
    share: {},
    skills: [],
    remove: [],
    notes: [],
  };

  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`source_paths entry not found: ${path}`);
    const text = await readFile(path, "utf8");
    const isOptimized =
      /suggested experience order/i.test(text) ||
      (/short phrase/i.test(text) && /proud project/i.test(text) && /###\s*\d+\./.test(text));

    if (isOptimized) {
      const parsed = parseOptimizedWaasDraft(text);
      sources.push({ path, kind: "optimized_draft" });
      merged = {
        experience: parsed.experience.length ? parsed.experience : merged.experience,
        education: parsed.education ?? merged.education,
        share: { ...merged.share, ...parsed.share },
        skills: parsed.skills.length ? parsed.skills : merged.skills,
        remove: [...new Set([...merged.remove, ...parsed.remove])],
        notes: [...merged.notes, ...parsed.notes.map((n) => `${path}: ${n}`)],
      };
    } else {
      const parsed = parseResumeLikeText(text);
      sources.push({ path, kind: path.endsWith(".tex") || /resume|bank/i.test(path) ? "resume_or_bank" : "other" });
      if (!merged.experience.length && parsed.experience?.length) {
        merged.experience = parsed.experience;
      }
      merged.notes.push(...(parsed.notes ?? []).map((n) => `${path}: ${n}`));
    }
  }

  const live =
    input.compare_live === false
      ? null
      : await fetchWaasProfile().catch((error) => {
          merged.notes.push(`Live profile unavailable: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });

  const built = buildUpdatePayloadFromDraft(merged, live, {
    include_optional: input.include_optional,
  });

  return {
    sources,
    parsed: merged,
    live: live
      ? {
          experienceCount: live.experience.length,
          skillsCount: live.skills.length,
          shortPhrase: live.share.shortPhrase,
        }
      : null,
    ...built,
  };
}
