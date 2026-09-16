import { BASE_URL, fetchPage, readInertiaPage } from "./waas.js";

export type ProfileExperience = {
  id: number;
  company: string;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  currentlyWorkHere: boolean;
  summary: string | null;
};

export type ProfileEducation = {
  id: number;
  school: string;
  degree: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  summary: string | null;
};

export type ProfileSkill = {
  id: number;
  name: string;
  rating: string;
};

export type WaasProfile = {
  profileId: number;
  shortId: string;
  fullName: string;
  email: string | null;
  personal: {
    firstName: string | null;
    lastName: string | null;
    location: string | null;
    github: string | null;
    linkedin: string | null;
    phone: string | null;
  };
  preferences: {
    role: string | null;
    engTypes: string[];
    jobTypes: string[];
    remote: string | null;
    relocate: string | null;
    relocateTo: string[];
    usAuthorized: string | null;
    usVisaSponsorship: string | null;
    inSchool: string | null;
    schoolName: string | null;
    gradDate: string | null;
    internshipDate: string | null;
    salaryMin: number | null;
    companySizes: { value: string; rating: string }[];
  };
  share: {
    shortPhrase: string | null;
    lookingFor: string | null;
    proudProject: string | null;
    shared: boolean;
  };
  experience: ProfileExperience[];
  education: ProfileEducation[];
  skills: ProfileSkill[];
  sections: { name: string; title: string; url: string; status: string }[];
  editUrl: string;
  previewHint: string;
  fetchedAt: string;
};

type RawPosition = {
  id?: number;
  employer_name_other?: string | null;
  title?: string | null;
  location?: string | null;
  summary?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  is_current?: boolean;
  employer?: { name?: string | null } | null;
};

type RawEducation = {
  id?: number;
  school_name_other?: string | null;
  degree?: string | null;
  field_of_study?: string | null;
  summary?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  school?: { name?: string | null } | null;
};

type SectionAppProps = {
  id?: number;
  short_id?: string;
  full_name?: string;
  shared?: boolean;
  updateUrl?: string;
  sectionInfo?: { name?: string; title?: string; url?: string; status?: string }[];
  data?: Record<string, unknown>;
};

export function extractSkillCatalog(html: string): Map<number, string> {
  const map = new Map<number, string>();
  const pattern = /\{\s*"label"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*"value"\s*:\s*(\d+)\s*\}/g;
  for (const match of html.matchAll(pattern)) {
    const label = match[1]?.replace(/\\"/g, '"');
    const id = Number(match[2]);
    if (label && Number.isFinite(id)) map.set(id, label);
  }
  return map;
}

export function normalizeProfile(
  sectionAppProps: SectionAppProps,
  skillCatalog: Map<number, string> = new Map(),
): WaasProfile {
  const data = (sectionAppProps.data ?? {}) as Record<string, unknown>;
  const positions = Array.isArray(data.positions) ? (data.positions as RawPosition[]) : [];
  const educations = Array.isArray(data.educations) ? (data.educations as RawEducation[]) : [];
  const topSkills = Array.isArray(data.top_skills)
    ? (data.top_skills as { value?: number; rating?: string }[])
    : [];
  const companySizes = Array.isArray(data.company_sizes)
    ? (data.company_sizes as { value?: string; rating?: string }[])
    : [];

  return {
    profileId: Number(sectionAppProps.id ?? 0),
    shortId: String(sectionAppProps.short_id ?? ""),
    fullName: String(sectionAppProps.full_name ?? `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim()),
    email: data.email ? String(data.email) : null,
    personal: {
      firstName: data.first_name ? String(data.first_name) : null,
      lastName: data.last_name ? String(data.last_name) : null,
      location: data.city_current ? String(data.city_current) : null,
      github: data.github ? String(data.github) : null,
      linkedin: data.linkedin ? String(data.linkedin) : null,
      phone: data.phone_number ? String(data.phone_number) : null,
    },
    preferences: {
      role: data.role ? String(data.role) : null,
      engTypes: stringArray(data.eng_type),
      jobTypes: stringArray(data.job_type),
      remote: data.remote ? String(data.remote) : null,
      relocate: data.relocate ? String(data.relocate) : null,
      relocateTo: stringArray(data.relocate_to_preset),
      usAuthorized: data.us_authorized ? String(data.us_authorized) : null,
      usVisaSponsorship: data.us_visa_sponsorship ? String(data.us_visa_sponsorship) : null,
      inSchool: data.in_school ? String(data.in_school) : null,
      schoolName: data.school_name ? String(data.school_name) : null,
      gradDate: data.grad_date ? String(data.grad_date) : null,
      internshipDate: data.internship_date ? String(data.internship_date) : null,
      salaryMin: typeof data.salary_min === "number" ? data.salary_min : null,
      companySizes: companySizes
        .filter((entry) => entry.value)
        .map((entry) => ({ value: String(entry.value), rating: String(entry.rating ?? "") })),
    },
    share: {
      shortPhrase: data.short_phrase ? String(data.short_phrase) : null,
      lookingFor: data.looking_for ? String(data.looking_for) : null,
      proudProject: data.proud_project ? String(data.proud_project) : null,
      shared: Boolean(sectionAppProps.shared ?? data.share === "yes"),
    },
    experience: positions.map((position) => ({
      id: Number(position.id ?? 0),
      company: String(position.employer_name_other || position.employer?.name || "Unknown"),
      title: String(position.title || ""),
      location: position.location ? String(position.location) : null,
      startDate: position.start_date ? String(position.start_date) : null,
      endDate: position.end_date ? String(position.end_date) : null,
      currentlyWorkHere: Boolean(position.is_current),
      summary: position.summary ? String(position.summary) : null,
    })),
    education: educations.map((edu) => ({
      id: Number(edu.id ?? 0),
      school: String(edu.school?.name || edu.school_name_other || "Unknown"),
      degree: edu.degree ? String(edu.degree) : null,
      fieldOfStudy: edu.field_of_study ? String(edu.field_of_study) : null,
      startDate: edu.start_date ? String(edu.start_date) : null,
      endDate: edu.end_date ? String(edu.end_date) : null,
      summary: edu.summary ? String(edu.summary) : null,
    })),
    skills: topSkills
      .filter((skill) => skill.value != null)
      .map((skill) => {
        const id = Number(skill.value);
        return {
          id,
          name: skillCatalog.get(id) ?? `skill_${id}`,
          rating: String(skill.rating ?? "unknown"),
        };
      }),
    sections: (sectionAppProps.sectionInfo ?? []).map((section) => ({
      name: String(section.name ?? ""),
      title: String(section.title ?? ""),
      url: section.url ? `${BASE_URL}${section.url}` : "",
      status: String(section.status ?? ""),
    })),
    editUrl: `${BASE_URL}/application/experience`,
    previewHint:
      "Open My Profile and click “Want to know what your profile looks like to YC companies?” (waas_preview_profile coming in #3).",
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWaasProfile(): Promise<WaasProfile> {
  // Experience section HTML includes the full profile payload + skill catalog options.
  const { response, html } = await fetchPage("/application/experience");
  if (!response.ok) {
    throw new Error(`Failed to load WAAS profile (${response.status}).`);
  }

  const page = readInertiaPage(html);
  const sectionAppProps = page?.props?.sectionAppProps as SectionAppProps | undefined;
  if (!sectionAppProps?.data) {
    throw new Error(
      "Could not parse WAAS profile from /application/experience. Session may be expired — run npm run login.",
    );
  }

  return normalizeProfile(sectionAppProps, extractSkillCatalog(html));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}
