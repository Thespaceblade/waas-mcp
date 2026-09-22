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
  previewUrl: string;
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
      phone: formatPhoneNumber(data.phone_number),
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
    experience: mapPositions(positions),
    education: mapEducations(educations),
    skills: mapSkills(topSkills, skillCatalog),
    sections: (sectionAppProps.sectionInfo ?? []).map((section) => ({
      name: String(section.name ?? ""),
      title: String(section.title ?? ""),
      url: section.url ? `${BASE_URL}${section.url}` : "",
      status: String(section.status ?? ""),
    })),
    editUrl: `${BASE_URL}/application/experience`,
    previewUrl: `${BASE_URL}/application/preview`,
    previewHint: "Use waas_preview_profile to see the company-facing rendering.",
    fetchedAt: new Date().toISOString(),
  };
}

export type WaasProfilePreview = {
  cid: string;
  dataType: string;
  previewPageUrl: string;
  iframeUrl: string;
  fullName: string;
  avatarUrl: string | null;
  headline: {
    role: string | null;
    subtypes: string | null;
    experienceDisplay: string | null;
    location: string | null;
    gradDateDisplay: string | null;
  };
  share: {
    shortPhrase: string | null;
    lookingFor: string | null;
    proudProject: string | null;
  };
  pretty: {
    positions: string | null;
    educations: string | null;
  };
  experience: ProfileExperience[];
  education: ProfileEducation[];
  skills: ProfileSkill[];
  links: {
    github: string | null;
    linkedin: string | null;
  };
  fetchedAt: string;
};

export function normalizeProfilePreview(
  candidate: {
    cid?: string;
    data_type?: string;
    profile_meta?: { id?: number; short_id?: string };
    profile?: {
      full_name?: string;
      data?: Record<string, unknown>;
    };
    data?: Record<string, unknown>;
  },
  skillCatalog: Map<number, string> = new Map(),
  urls?: { previewPageUrl?: string; iframeUrl?: string },
): WaasProfilePreview {
  const data = (candidate.data ?? candidate.profile?.data ?? {}) as Record<string, unknown>;
  const positions = Array.isArray(data.positions) ? (data.positions as RawPosition[]) : [];
  const educations = Array.isArray(data.educations) ? (data.educations as RawEducation[]) : [];
  const topSkills = Array.isArray(data.top_skills)
    ? (data.top_skills as { value?: number; rating?: string }[])
    : [];
  const fullName =
    candidate.profile?.full_name ||
    `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() ||
    String(candidate.profile_meta?.short_id ?? candidate.cid ?? "");

  return {
    cid: String(candidate.cid ?? candidate.profile_meta?.short_id ?? ""),
    dataType: String(candidate.data_type ?? "full_candidate"),
    previewPageUrl: urls?.previewPageUrl ?? `${BASE_URL}/application/preview`,
    iframeUrl: urls?.iframeUrl ?? `${BASE_URL}/application/preview_iframe`,
    fullName,
    avatarUrl: data.avatar_thumb ? String(data.avatar_thumb) : null,
    headline: {
      role: data.pretty_role ? String(data.pretty_role) : null,
      subtypes: data.pretty_subtype ? String(data.pretty_subtype) : null,
      experienceDisplay: data.experienceDisplay ? String(data.experienceDisplay) : null,
      location: data.city_current ? String(data.city_current) : null,
      gradDateDisplay: data.grad_date_display ? String(data.grad_date_display) : null,
    },
    share: {
      shortPhrase: data.short_phrase ? String(data.short_phrase) : null,
      lookingFor: data.looking_for ? String(data.looking_for) : null,
      proudProject: data.proud_project ? String(data.proud_project) : null,
    },
    pretty: {
      positions: data.pretty_positions ? String(data.pretty_positions) : null,
      educations: data.pretty_educations ? String(data.pretty_educations) : null,
    },
    experience: mapPositions(positions),
    education: mapEducations(educations),
    skills: mapSkills(topSkills, skillCatalog),
    links: {
      github: data.github ? String(data.github) : null,
      linkedin: data.linkedin ? String(data.linkedin) : null,
    },
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

export async function fetchWaasProfilePreview(): Promise<WaasProfilePreview> {
  const previewPage = await fetchPage("/application/preview");
  if (!previewPage.response.ok) {
    throw new Error(`Failed to load WAAS profile preview (${previewPage.response.status}).`);
  }
  const previewProps = readInertiaPage(previewPage.html)?.props ?? {};
  const iframePath = String(previewProps.previewIframeUrl ?? "/application/preview_iframe");
  const iframePathOnly = iframePath.startsWith("http")
    ? new URL(iframePath).pathname
    : iframePath;

  const iframe = await fetchPage(iframePathOnly);
  if (!iframe.response.ok) {
    throw new Error(`Failed to load WAAS preview iframe (${iframe.response.status}).`);
  }

  const candidate = readInertiaPage(iframe.html)?.props?.candidate as
    | {
        cid?: string;
        data_type?: string;
        profile_meta?: { id?: number; short_id?: string };
        profile?: { full_name?: string; data?: Record<string, unknown> };
        data?: Record<string, unknown>;
      }
    | undefined;

  const data = candidate?.data ?? candidate?.profile?.data;
  if (!candidate || !data) {
    throw new Error(
      "Could not parse company-facing profile from /application/preview_iframe. Session may be expired — run npm run login.",
    );
  }

  // Skill labels live on the wizard pages; fetch experience HTML for the catalog.
  const experiencePage = await fetchPage("/application/experience");
  const skillCatalog = experiencePage.response.ok
    ? extractSkillCatalog(experiencePage.html)
    : extractSkillCatalog(iframe.html);

  return normalizeProfilePreview(candidate, skillCatalog, {
    previewPageUrl: `${BASE_URL}/application/preview`,
    iframeUrl: iframePath.startsWith("http") ? iframePath : `${BASE_URL}${iframePathOnly}`,
  });
}

function mapPositions(positions: RawPosition[]): ProfileExperience[] {
  return positions.map((position) => ({
    id: Number(position.id ?? 0),
    company: String(position.employer_name_other || position.employer?.name || "Unknown"),
    title: String(position.title || ""),
    location: position.location ? String(position.location) : null,
    startDate: position.start_date ? String(position.start_date) : null,
    endDate: position.end_date ? String(position.end_date) : null,
    currentlyWorkHere: Boolean(position.is_current),
    summary: position.summary ? String(position.summary) : null,
  }));
}

function mapEducations(educations: RawEducation[]): ProfileEducation[] {
  return educations.map((edu) => ({
    id: Number(edu.id ?? 0),
    school: String(edu.school?.name || edu.school_name_other || "Unknown"),
    degree: edu.degree ? String(edu.degree) : null,
    fieldOfStudy: edu.field_of_study ? String(edu.field_of_study) : null,
    startDate: edu.start_date ? String(edu.start_date) : null,
    endDate: edu.end_date ? String(edu.end_date) : null,
    summary: edu.summary ? String(edu.summary) : null,
  }));
}

function mapSkills(
  topSkills: { value?: number; rating?: string }[],
  skillCatalog: Map<number, string>,
): ProfileSkill[] {
  return topSkills
    .filter((skill) => skill.value != null)
    .map((skill) => {
      const id = Number(skill.value);
      return {
        id,
        name: skillCatalog.get(id) ?? `skill_${id}`,
        rating: String(skill.rating ?? "unknown"),
      };
    });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

/** WAAS often stores phone as { phone_country_code, phone_number }. */
export function formatPhoneNumber(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  if (typeof value === "object") {
    const obj = value as {
      phone_country_code?: string | number | null;
      phone_number?: string | number | null;
      number?: string | number | null;
      e164?: string | null;
    };
    if (obj.e164) return String(obj.e164);
    const national = obj.phone_number ?? obj.number;
    if (national == null || national === "") return null;
    const cc = obj.phone_country_code;
    return cc != null && String(cc).trim() !== ""
      ? `+${String(cc).replace(/^\+/, "")} ${String(national)}`
      : String(national);
  }
  return null;
}
