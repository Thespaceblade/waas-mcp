import {
  BASE_URL,
  extractCsrfToken,
  fetchPage,
  postApplicationSection,
  readInertiaPage,
} from "./waas.js";
import { extractSkillCatalog } from "./profile-client.js";

export type PositionUpdateInput = {
  id?: number;
  company?: string;
  title?: string;
  location?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  currently_work_here?: boolean;
  summary?: string | null;
};

export type EducationUpdateInput = {
  id?: number;
  school?: string;
  degree?: string | null;
  field_of_study?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  summary?: string | null;
};

export type SkillUpdateInput = {
  id?: number;
  name?: string;
  rating: "beginner" | "intermediate" | "advanced";
};

export type ExperienceMatchRef = {
  id?: number;
  /** Case-insensitive substring match against company or title. */
  match?: string;
};

export type ExperienceFixDatesInput = ExperienceMatchRef & {
  start_date?: string | null;
  end_date?: string | null;
};

export type ExperienceSetCurrentInput = ExperienceMatchRef & {
  currently_work_here: boolean;
};

export type ExperienceRenameInput = ExperienceMatchRef & {
  company?: string;
  title?: string;
};

export type UpdateProfileInput = {
  dry_run?: boolean;
  experience?: {
    mode?: "replace" | "patch";
    positions?: PositionUpdateInput[];
    remove_ids?: number[];
    /** Remove entries whose company/title contains any of these strings. */
    remove_match?: string[];
    /** Fix start/end dates by id or match. */
    fix_dates?: ExperienceFixDatesInput[];
    /** Set/clear “I currently work here” by id or match. */
    set_current?: ExperienceSetCurrentInput[];
    /** Rename company and/or title by id or match. */
    rename?: ExperienceRenameInput[];
    order?: number[];
  };
  education?: EducationUpdateInput;
  skills?: {
    /** replace = full list (default); merge = upsert into existing. */
    mode?: "replace" | "merge";
    items?: SkillUpdateInput[];
    /** Remove skills by catalog id (merge or replace-after-remove). */
    remove_ids?: number[];
    /** Remove skills by name (case-insensitive). */
    remove_names?: string[];
  };
  share?: {
    short_phrase?: string;
    looking_for?: string;
    proud_project?: string;
  };
};

type RawPosition = Record<string, unknown>;
type RawEducation = Record<string, unknown>;
type RawSkill = { value?: number; rating?: string };

type ProfileData = Record<string, unknown> & {
  positions?: RawPosition[];
  educations?: RawEducation[];
  top_skills?: RawSkill[];
  short_phrase?: string;
  looking_for?: string;
  proud_project?: string;
  share?: string;
  waas_event_apply?: unknown;
};

export type ProfileSectionDiff = {
  section: "experience" | "skills" | "share";
  changed: boolean;
  before: unknown;
  after: unknown;
  summary: string[];
};

export type UpdateProfileResult = {
  dry_run: boolean;
  written: boolean;
  sections: ProfileSectionDiff[];
  requests: { method: string; url: string; from: string; fields: string[] }[];
  errors: string[];
  verifiedAt: string | null;
};

const MAX_SKILLS = 10;
const SKILL_RATINGS = new Set(["beginner", "intermediate", "advanced"]);
const SHORT_PHRASE_MIN = 40;
const LOOKING_FOR_MIN = 80;
const PROUD_PROJECT_MIN = 60;
const BROKEN_SHORT_PHRASE = /^(react|python|typescript|javascript|swift|java|ml|ai|rag|intern|student|engineer|developer)$/i;

export function normalizeMonthDate(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const trimmed = String(value).trim();
  const ym = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (ym) return `${ym[1]}-${ym[2]}-01`;
  const ymd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-01`;
  throw new Error(`Invalid date "${value}". Use YYYY-MM or YYYY-MM-01.`);
}

export function applyExperienceUpdates(
  currentPositions: RawPosition[],
  currentEducations: RawEducation[],
  experience?: UpdateProfileInput["experience"],
  education?: EducationUpdateInput,
): { positions: RawPosition[]; educations: RawEducation[]; changed: boolean; summary: string[] } {
  const summary: string[] = [];
  let positions = currentPositions.map((p) => ({ ...p }));
  let educations = currentEducations.map((e) => ({ ...e }));
  let changed = false;

  if (experience) {
    const mode = experience.mode ?? (experience.positions ? "replace" : "patch");

    if (experience.remove_ids?.length) {
      const remove = new Set(experience.remove_ids);
      const before = positions.length;
      positions = positions.filter((p) => !remove.has(Number(p.id)));
      if (positions.length !== before) {
        changed = true;
        summary.push(`Removed ${before - positions.length} experience entr${before - positions.length === 1 ? "y" : "ies"}.`);
      }
    }

    if (experience.remove_match?.length) {
      for (const needle of experience.remove_match) {
        const indexes = findMatchIndexes(positions, { match: needle });
        if (indexes.length === 0) {
          throw new Error(`remove_match “${needle}” matched no experience entries.`);
        }
        const removed = indexes.map((i) => positions[i]!);
        positions = positions.filter((_, i) => !indexes.includes(i));
        changed = true;
        summary.push(
          `Removed by match “${needle}”: ${removed.map((p) => labelPosition(p)).join("; ")}.`,
        );
      }
    }

    if (experience.rename?.length) {
      for (const op of experience.rename) {
        const idx = resolveOneIndex(positions, op, "rename");
        const before = labelPosition(positions[idx]!);
        if (op.company !== undefined) {
          positions[idx] = {
            ...positions[idx],
            employer_name_other: op.company,
            employer: null,
          };
        }
        if (op.title !== undefined) {
          positions[idx] = { ...positions[idx], title: op.title };
        }
        changed = true;
        summary.push(`Renamed ${before} → ${labelPosition(positions[idx]!)}.`);
      }
    }

    if (experience.fix_dates?.length) {
      for (const op of experience.fix_dates) {
        if (op.start_date === undefined && op.end_date === undefined) {
          throw new Error("fix_dates entries need start_date and/or end_date.");
        }
        const idx = resolveOneIndex(positions, op, "fix_dates");
        const before = positions[idx]!;
        const start =
          op.start_date !== undefined
            ? normalizeMonthDate(op.start_date)
            : ((before.start_date as string | null | undefined) ?? null);
        let end =
          op.end_date !== undefined
            ? normalizeMonthDate(op.end_date)
            : ((before.end_date as string | null | undefined) ?? null);
        let isCurrent = Boolean(before.is_current);
        if (isCurrent && end) isCurrent = false;
        if (end) isCurrent = false;
        const sameStart = String(before.start_date ?? "") === String(start ?? "");
        const sameEnd = String(before.end_date ?? "") === String(end ?? "");
        const sameCurrent = Boolean(before.is_current) === isCurrent;
        if (sameStart && sameEnd && sameCurrent) continue;
        positions[idx] = {
          ...before,
          start_date: start,
          end_date: end,
          is_current: isCurrent,
        };
        changed = true;
        summary.push(
          `Fixed dates on ${labelPosition(positions[idx]!)} → ${start ?? "?"}–${end ?? (isCurrent ? "present" : "?")}.`,
        );
      }
    }

    if (experience.set_current?.length) {
      for (const op of experience.set_current) {
        const idx = resolveOneIndex(positions, op, "set_current");
        const before = positions[idx]!;
        const nextEnd = op.currently_work_here ? null : before.end_date ?? null;
        if (Boolean(before.is_current) === op.currently_work_here && String(before.end_date ?? "") === String(nextEnd ?? "")) {
          continue;
        }
        positions[idx] = {
          ...before,
          is_current: op.currently_work_here,
          end_date: nextEnd,
        };
        changed = true;
        summary.push(
          `${op.currently_work_here ? "Set" : "Cleared"} current flag on ${labelPosition(positions[idx]!)}.`,
        );
      }
    }

    if (experience.positions?.length) {
      if (mode === "replace") {
        positions = experience.positions.map((input, index) =>
          mergePosition(findById(currentPositions, input.id), input, index),
        );
        changed = true;
        summary.push(`Replaced experience list with ${positions.length} entr${positions.length === 1 ? "y" : "ies"}.`);
      } else {
        for (const input of experience.positions) {
          if (input.id != null) {
            const idx = positions.findIndex((p) => Number(p.id) === input.id);
            if (idx < 0) throw new Error(`Experience id ${input.id} not found.`);
            positions[idx] = mergePosition(positions[idx], input, idx);
            changed = true;
            summary.push(`Updated experience #${input.id} (${String(positions[idx].title || "untitled")}).`);
          } else {
            positions.push(mergePosition(undefined, input, positions.length));
            changed = true;
            summary.push(`Added experience: ${input.title ?? "untitled"} @ ${input.company ?? "unknown"}.`);
          }
        }
      }
    }

    if (experience.order?.length) {
      const byId = new Map(positions.map((p) => [Number(p.id), p]));
      const ordered: RawPosition[] = [];
      for (const id of experience.order) {
        const row = byId.get(id);
        if (!row) throw new Error(`Reorder failed: experience id ${id} not found.`);
        ordered.push(row);
        byId.delete(id);
      }
      ordered.push(...byId.values());
      if (JSON.stringify(ordered.map((p) => p.id)) !== JSON.stringify(positions.map((p) => p.id))) {
        positions = ordered;
        changed = true;
        summary.push(`Reordered experiences: [${experience.order.join(", ")}].`);
      }
    }
  }

  if (education) {
    if (educations.length === 0) {
      educations = [mergeEducation(undefined, education)];
      changed = true;
      summary.push("Added education entry.");
    } else {
      const targetId = education.id ?? Number(educations[0]?.id);
      const idx = educations.findIndex((e) => Number(e.id) === targetId);
      const at = idx >= 0 ? idx : 0;
      const merged = mergeEducation(educations[at], education);
      if (JSON.stringify(summarizeEducations([merged])) !== JSON.stringify(summarizeEducations([educations[at]!]))) {
        educations[at] = merged;
        changed = true;
        summary.push(
          `Updated education${education.end_date ? ` (end → ${normalizeMonthDate(education.end_date)})` : ""}.`,
        );
      }
    }
  }

  return { positions, educations, changed, summary };
}

function labelPosition(position: RawPosition): string {
  const company = String(position.employer_name_other || (position.employer as { name?: string } | null)?.name || "?");
  const title = String(position.title || "?");
  return `${company} — ${title}`;
}

function findMatchIndexes(positions: RawPosition[], ref: ExperienceMatchRef): number[] {
  if (ref.id != null) {
    const idx = positions.findIndex((p) => Number(p.id) === ref.id);
    return idx >= 0 ? [idx] : [];
  }
  if (!ref.match?.trim()) return [];
  const needle = ref.match.trim().toLowerCase();
  return positions
    .map((p, i) => ({ i, label: labelPosition(p).toLowerCase() }))
    .filter((row) => row.label.includes(needle))
    .map((row) => row.i);
}

function resolveOneIndex(positions: RawPosition[], ref: ExperienceMatchRef, op: string): number {
  if (ref.id == null && !ref.match?.trim()) {
    throw new Error(`${op} requires id or match.`);
  }
  const indexes = findMatchIndexes(positions, ref);
  if (indexes.length === 0) {
    throw new Error(`${op} matched no experience for ${ref.id != null ? `id=${ref.id}` : `match="${ref.match}"`}.`);
  }
  if (indexes.length > 1) {
    throw new Error(
      `${op} matched ${indexes.length} experiences for match="${ref.match}". Pass id to disambiguate.`,
    );
  }
  return indexes[0]!;
}

export function validateShareCopy(share: {
  short_phrase?: string;
  looking_for?: string;
  proud_project?: string;
}): string[] {
  const errors: string[] = [];

  if (share.short_phrase !== undefined) {
    const phrase = share.short_phrase.trim();
    if (!phrase) {
      errors.push("short_phrase cannot be empty.");
    } else if (BROKEN_SHORT_PHRASE.test(phrase) || phrase.split(/\s+/).length < 4) {
      errors.push(
        `short_phrase looks broken (“${phrase.slice(0, 40)}”). Use a full headline (≥${SHORT_PHRASE_MIN} chars, not a single skill name).`,
      );
    } else if (phrase.length < SHORT_PHRASE_MIN) {
      errors.push(`short_phrase is too short (${phrase.length} < ${SHORT_PHRASE_MIN}).`);
    }
  }

  if (share.looking_for !== undefined) {
    const text = share.looking_for.trim();
    if (!text) {
      errors.push("looking_for cannot be empty.");
    } else if (text.length < LOOKING_FOR_MIN) {
      errors.push(`looking_for is too short (${text.length} < ${LOOKING_FOR_MIN}).`);
    }
  }

  if (share.proud_project !== undefined) {
    const text = share.proud_project.trim();
    if (!text) {
      errors.push("proud_project cannot be empty.");
    } else if (text.length < PROUD_PROJECT_MIN) {
      errors.push(`proud_project is too short (${text.length} < ${PROUD_PROJECT_MIN}).`);
    }
  }

  return errors;
}

export function applySkillsUpdate(
  current: RawSkill[],
  skillCatalog: Map<number, string>,
  skills?: UpdateProfileInput["skills"],
): { top_skills: RawSkill[]; changed: boolean; summary: string[] } {
  if (!skills || (!skills.items?.length && !skills.remove_ids?.length && !skills.remove_names?.length)) {
    return { top_skills: current, changed: false, summary: [] };
  }

  const nameToId = new Map<string, number>();
  for (const [id, name] of skillCatalog) {
    nameToId.set(name.toLowerCase(), id);
  }

  const resolveItem = (item: SkillUpdateInput): RawSkill => {
    if (!SKILL_RATINGS.has(item.rating)) {
      throw new Error(`Invalid skill rating "${item.rating}". Use beginner|intermediate|advanced.`);
    }
    let id = item.id;
    if (id == null) {
      if (!item.name) throw new Error("Each skill needs id or name.");
      id = nameToId.get(item.name.toLowerCase());
      if (id == null) {
        throw new Error(`Unknown skill name "${item.name}". Pass catalog id from waas_get_profile.`);
      }
    }
    return { value: id, rating: item.rating };
  };

  const mode = skills.mode ?? "replace";
  let next: RawSkill[];
  const summary: string[] = [];

  if (mode === "merge") {
    next = current.map((s) => ({ ...s }));
    const removeIds = new Set(skills.remove_ids ?? []);
    for (const name of skills.remove_names ?? []) {
      const id = nameToId.get(name.toLowerCase());
      if (id == null) throw new Error(`Unknown skill name to remove: "${name}".`);
      removeIds.add(id);
    }
    if (removeIds.size) {
      const before = next.length;
      next = next.filter((s) => !removeIds.has(Number(s.value)));
      if (next.length !== before) {
        summary.push(`Removed ${before - next.length} skill(s).`);
      }
    }
    for (const item of skills.items ?? []) {
      const resolved = resolveItem(item);
      const idx = next.findIndex((s) => Number(s.value) === Number(resolved.value));
      if (idx >= 0) {
        next[idx] = resolved;
        summary.push(
          `Updated skill ${skillCatalog.get(Number(resolved.value)) ?? resolved.value} → ${resolved.rating}.`,
        );
      } else {
        next.push(resolved);
        summary.push(
          `Added skill ${skillCatalog.get(Number(resolved.value)) ?? resolved.value} (${resolved.rating}).`,
        );
      }
    }
  } else {
    if (skills.remove_ids?.length || skills.remove_names?.length) {
      throw new Error('remove_ids/remove_names require skills.mode="merge" (or omit them and send a full replace list).');
    }
    if (!skills.items?.length) {
      throw new Error("skills.replace requires items[] (max 10).");
    }
    next = skills.items.map(resolveItem);
    summary.push(
      `Replace skills (${next.length}): ${next
        .map((s) => `${skillCatalog.get(Number(s.value)) ?? `skill_${s.value}`} (${s.rating})`)
        .join(", ")}`,
    );
  }

  if (next.length > MAX_SKILLS) {
    throw new Error(`Skills max is ${MAX_SKILLS}; got ${next.length}.`);
  }

  const beforeKey = JSON.stringify(current.map((s) => [s.value, s.rating]));
  const afterKey = JSON.stringify(next.map((s) => [s.value, s.rating]));
  if (beforeKey === afterKey) {
    return { top_skills: current, changed: false, summary: [] };
  }

  return { top_skills: next, changed: true, summary };
}

export function applyShareUpdate(
  current: ProfileData,
  share?: UpdateProfileInput["share"],
): { data: Record<string, unknown>; changed: boolean; summary: string[] } {
  if (!share) {
    return {
      data: {
        short_phrase: current.short_phrase ?? null,
        looking_for: current.looking_for ?? null,
        proud_project: current.proud_project ?? null,
        share: current.share ?? "yes",
        ...(current.waas_event_apply !== undefined ? { waas_event_apply: current.waas_event_apply } : {}),
      },
      changed: false,
      summary: [],
    };
  }

  const validationErrors = validateShareCopy(share);
  if (validationErrors.length) {
    throw new Error(`Share validation failed: ${validationErrors.join(" ")}`);
  }

  const next = {
    short_phrase: share.short_phrase ?? current.short_phrase ?? null,
    looking_for: share.looking_for ?? current.looking_for ?? null,
    proud_project: share.proud_project ?? current.proud_project ?? null,
    share: current.share ?? "yes",
    ...(current.waas_event_apply !== undefined ? { waas_event_apply: current.waas_event_apply } : {}),
  };

  const summary: string[] = [];
  if (share.short_phrase !== undefined && share.short_phrase !== current.short_phrase) {
    summary.push("Update short_phrase.");
  }
  if (share.looking_for !== undefined && share.looking_for !== current.looking_for) {
    summary.push("Update looking_for.");
  }
  if (share.proud_project !== undefined && share.proud_project !== current.proud_project) {
    summary.push("Update proud_project.");
  }

  return { data: next, changed: summary.length > 0, summary };
}

/** Empty arrays must become ["_"] so WAAS clears the list instead of no-oping. */
export function withEmptyListSentinel<T>(items: T[]): T[] | ["_"] {
  return items.length === 0 ? ["_"] : items;
}

export function summarizePositions(positions: RawPosition[]) {
  return positions.map((p) => ({
    id: p.id ?? null,
    company: String(p.employer_name_other || (p.employer as { name?: string } | null)?.name || ""),
    title: String(p.title ?? ""),
    start_date: p.start_date ?? null,
    end_date: p.end_date ?? null,
    is_current: Boolean(p.is_current),
  }));
}

export function summarizeEducations(educations: RawEducation[]) {
  return educations.map((e) => ({
    id: e.id ?? null,
    school: String((e.school as { name?: string } | null)?.name || e.school_name_other || ""),
    degree: e.degree ?? null,
    field_of_study: e.field_of_study ?? null,
    start_date: e.start_date ?? null,
    end_date: e.end_date ?? null,
  }));
}

export function summarizeSkills(skills: RawSkill[], catalog: Map<number, string>) {
  return skills.map((s) => ({
    id: Number(s.value),
    name: catalog.get(Number(s.value)) ?? `skill_${s.value}`,
    rating: String(s.rating ?? ""),
  }));
}

export async function updateWaasProfile(input: UpdateProfileInput): Promise<UpdateProfileResult> {
  const dryRun = input.dry_run !== false;
  if (!input.experience && !input.education && !input.skills && !input.share) {
    throw new Error("Provide at least one of: experience, education, skills, share.");
  }

  const experiencePage = await fetchPage("/application/experience");
  if (!experiencePage.response.ok) {
    throw new Error(`Failed to load profile (${experiencePage.response.status}).`);
  }
  const sectionAppProps = readInertiaPage(experiencePage.html)?.props?.sectionAppProps as
    | { data?: ProfileData }
    | undefined;
  const baseline = sectionAppProps?.data;
  if (!baseline) {
    throw new Error("Could not parse profile baseline. Session may be expired — run npm run login.");
  }

  const skillCatalog = extractSkillCatalog(experiencePage.html);
  const currentPositions = Array.isArray(baseline.positions) ? baseline.positions : [];
  const currentEducations = Array.isArray(baseline.educations) ? baseline.educations : [];
  const currentSkills = Array.isArray(baseline.top_skills) ? baseline.top_skills : [];

  const experiencePlan = applyExperienceUpdates(
    currentPositions,
    currentEducations,
    input.experience,
    input.education,
  );
  const skillsPlan = applySkillsUpdate(currentSkills, skillCatalog, input.skills);
  const sharePlan = applyShareUpdate(baseline, input.share);

  const sections: ProfileSectionDiff[] = [];
  const requests: UpdateProfileResult["requests"] = [];
  const errors: string[] = [];

  if (input.experience || input.education) {
    sections.push({
      section: "experience",
      changed: experiencePlan.changed,
      before: {
        positions: summarizePositions(currentPositions),
        educations: summarizeEducations(currentEducations),
      },
      after: {
        positions: summarizePositions(experiencePlan.positions),
        educations: summarizeEducations(experiencePlan.educations),
      },
      summary: experiencePlan.summary,
    });
    if (experiencePlan.changed) {
      requests.push({
        method: "POST",
        url: `${BASE_URL}/application`,
        from: "experience",
        fields: ["positions", "educations"],
      });
    }
  }

  if (input.skills) {
    sections.push({
      section: "skills",
      changed: skillsPlan.changed,
      before: summarizeSkills(currentSkills, skillCatalog),
      after: summarizeSkills(skillsPlan.top_skills, skillCatalog),
      summary: skillsPlan.summary,
    });
    if (skillsPlan.changed) {
      requests.push({
        method: "POST",
        url: `${BASE_URL}/application`,
        from: "skills",
        fields: ["top_skills"],
      });
    }
  }

  if (input.share) {
    sections.push({
      section: "share",
      changed: sharePlan.changed,
      before: {
        short_phrase: baseline.short_phrase ?? null,
        looking_for: baseline.looking_for ?? null,
        proud_project: baseline.proud_project ?? null,
      },
      after: {
        short_phrase: sharePlan.data.short_phrase ?? null,
        looking_for: sharePlan.data.looking_for ?? null,
        proud_project: sharePlan.data.proud_project ?? null,
      },
      summary: sharePlan.summary,
    });
    if (sharePlan.changed) {
      requests.push({
        method: "POST",
        url: `${BASE_URL}/application`,
        from: "share",
        fields: Object.keys(sharePlan.data),
      });
    }
  }

  if (dryRun) {
    return {
      dry_run: true,
      written: false,
      sections,
      requests,
      errors,
      verifiedAt: null,
    };
  }

  if (experiencePlan.changed) {
    await writeSection("experience", {
      positions: withEmptyListSentinel(experiencePlan.positions.map(stripPositionForWrite)),
      educations: withEmptyListSentinel(experiencePlan.educations.map(stripEducationForWrite)),
    }, errors);
  }
  if (skillsPlan.changed) {
    await writeSection("skills", { top_skills: skillsPlan.top_skills }, errors);
  }
  if (sharePlan.changed) {
    await writeSection("share", sharePlan.data, errors);
  }

  return {
    dry_run: false,
    written: errors.length === 0 && requests.length > 0,
    sections,
    requests,
    errors,
    verifiedAt: new Date().toISOString(),
  };
}

async function writeSection(
  from: "experience" | "skills" | "share",
  data: Record<string, unknown>,
  errors: string[],
): Promise<void> {
  const page = await fetchPage(`/application/${from}`);
  if (!page.response.ok) {
    errors.push(`Failed to load /application/${from} before write (${page.response.status}).`);
    return;
  }
  const csrf = extractCsrfToken(page.html);
  const { response, json, text } = await postApplicationSection(from, data, csrf, "/application");
  if (!response.ok) {
    const message =
      (Array.isArray(json?.errors) && json.errors.map(String).join("; ")) ||
      (typeof json?.error === "string" && json.error) ||
      text.slice(0, 240) ||
      `HTTP ${response.status}`;
    errors.push(`${from}: ${message}`);
  }
}

function findById(rows: RawPosition[], id?: number): RawPosition | undefined {
  if (id == null) return undefined;
  return rows.find((row) => Number(row.id) === id);
}

function mergePosition(
  existing: RawPosition | undefined,
  input: PositionUpdateInput,
  index: number,
): RawPosition {
  const currently = input.currently_work_here ?? Boolean(existing?.is_current);
  const start = input.start_date !== undefined ? normalizeMonthDate(input.start_date) : (existing?.start_date as string | null | undefined) ?? null;
  let end =
    input.end_date !== undefined ? normalizeMonthDate(input.end_date) : (existing?.end_date as string | null | undefined) ?? null;
  if (currently) end = null;

  if (input.title === undefined && !existing?.title) {
    throw new Error(`Experience entry #${index + 1} needs a title.`);
  }

  const company =
    input.company ??
    String(existing?.employer_name_other || (existing?.employer as { name?: string } | null)?.name || "");

  if (!existing && !company) {
    throw new Error(`New experience entry #${index + 1} needs a company.`);
  }

  const next: RawPosition = {
    ...(existing ?? {}),
    title: input.title ?? existing?.title ?? "",
    location: input.location !== undefined ? input.location : (existing?.location ?? null),
    summary: input.summary !== undefined ? input.summary : (existing?.summary ?? null),
    start_date: start,
    end_date: end,
    is_current: currently,
    employer_name_other: company || existing?.employer_name_other || null,
    employer: existing?.employer ?? null,
    from_source_resume: existing?.from_source_resume ?? false,
  };

  if (existing?.id != null) {
    next.id = existing.id;
  } else if (input.id != null) {
    next.id = input.id;
  } else {
    next.temp_id = Date.now() + index;
    delete next.id;
  }

  return next;
}

function mergeEducation(existing: RawEducation | undefined, input: EducationUpdateInput): RawEducation {
  const next: RawEducation = {
    ...(existing ?? {}),
    degree: input.degree !== undefined ? input.degree : (existing?.degree ?? null),
    field_of_study:
      input.field_of_study !== undefined ? input.field_of_study : (existing?.field_of_study ?? null),
    summary: input.summary !== undefined ? input.summary : (existing?.summary ?? null),
    start_date:
      input.start_date !== undefined
        ? normalizeMonthDate(input.start_date)
        : ((existing?.start_date as string | null | undefined) ?? null),
    end_date:
      input.end_date !== undefined
        ? normalizeMonthDate(input.end_date)
        : ((existing?.end_date as string | null | undefined) ?? null),
    from_source_resume: existing?.from_source_resume ?? false,
  };

  if (input.school !== undefined) {
    const existingSchool = existing?.school as { id?: number; name?: string } | null | undefined;
    if (existingSchool?.name === input.school) {
      next.school = existingSchool;
      next.school_name_other = null;
    } else {
      next.school = null;
      next.school_name_other = input.school;
    }
  } else if (!existing) {
    next.school = null;
    next.school_name_other = null;
  }

  if (existing?.id != null) {
    next.id = existing.id;
  } else if (input.id != null) {
    next.id = input.id;
  } else {
    next.temp_id = Date.now();
    delete next.id;
  }

  return next;
}

function stripPositionForWrite(position: RawPosition): RawPosition {
  return {
    ...(position.id != null ? { id: position.id } : {}),
    ...(position.temp_id != null ? { temp_id: position.temp_id } : {}),
    employer_name_other: position.employer_name_other ?? null,
    employer: position.employer ?? null,
    title: position.title ?? "",
    location: position.location ?? null,
    summary: position.summary ?? null,
    start_date: position.start_date ?? null,
    end_date: position.end_date ?? null,
    is_current: Boolean(position.is_current),
    from_source_resume: Boolean(position.from_source_resume),
  };
}

function stripEducationForWrite(education: RawEducation): RawEducation {
  return {
    ...(education.id != null ? { id: education.id } : {}),
    ...(education.temp_id != null ? { temp_id: education.temp_id } : {}),
    school_name_other: education.school_name_other ?? null,
    school: education.school
      ? {
          id: (education.school as { id?: number }).id,
          name: (education.school as { name?: string }).name,
        }
      : null,
    degree: education.degree ?? null,
    field_of_study: education.field_of_study ?? null,
    summary: education.summary ?? null,
    start_date: education.start_date ?? null,
    end_date: education.end_date ?? null,
    from_source_resume: Boolean(education.from_source_resume),
  };
}
