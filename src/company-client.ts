import { BASE_URL, fetchPage, pick, readInertiaPage, skillNames } from "./waas.js";
import { fetchPublicPageHtml } from "./browser/page-html.js";
import { hasSession } from "./config.js";

export type OpenRole = {
  jobId: string;
  title: string;
  url: string;
  role: string;
  jobType: string;
  location: string;
  remote: boolean | null;
  minExperience: string | null;
  salaryRange: string | null;
  equityRange: string | null;
  visa: string | null;
  skills: string[];
};

export type Company = {
  slug: string;
  url: string;
  name: string;
  batch: string;
  tagline: string;
  description: string;
  website: string;
  location: string;
  teamSize: number | null;
  industry: string;
  isHiring: boolean | null;
  founders: { name: string; bio: string; linkedin: string }[];
  openRoles: OpenRole[];
  fetchedAt: string;
};

export async function fetchCompany(slug: string): Promise<Company> {
  let html: string;
  try {
    if (hasSession()) {
      const { response, html: loggedInHtml } = await fetchPage(`/companies/${slug}`);
      if (response.status === 404) {
        throw new Error(`No Work at a Startup company found for slug "${slug}".`);
      }
      if (!response.ok) {
        throw new Error(`Unexpected ${response.status} response while loading company ${slug}.`);
      }
      html = loggedInHtml;
    } else {
      throw new Error("no session");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("No Work at a Startup")) throw error;
    html = await fetchPublicPageHtml(`/companies/${slug}`);
  }
  return parseCompanyPage(html, slug);
}

export function parseCompanyPage(html: string, slug: string): Company {
  const companyUrl = `${BASE_URL}/companies/${slug}`;
  const page = readInertiaPage(html);
  const company =
    (page?.props?.rawCompany as Record<string, unknown> | undefined) ??
    (page?.props?.company as Record<string, unknown> | undefined);
  if (!company) {
    throw new Error(
      `Couldn't find company data on the page for ${slug}. Work at a Startup may have changed its markup.`,
    );
  }

  const jobs = Array.isArray(company.jobs) ? company.jobs : [];
  const openRoles: OpenRole[] = jobs
    .filter((job) => {
      const state = (job as { state?: string }).state;
      return !state || state === "visible";
    })
    .map((job) => {
      const j = job as Record<string, unknown>;
      return {
        jobId: String(j.id),
        title: String(j.title ?? ""),
        url: jobUrl(j),
        role: String(pick(j, "pretty_role", "role", "roleType") ?? ""),
        jobType: String(pick(j, "pretty_job_type", "jobType", "job_type") ?? ""),
        location: String(pick(j, "pretty_location_or_remote", "location") ?? ""),
        remote: (pick(j, "remote") as boolean | null) ?? null,
        minExperience: pick(j, "pretty_min_experience", "minExperience", "min_experience")
          ? String(pick(j, "pretty_min_experience", "minExperience", "min_experience"))
          : null,
        salaryRange: pick(j, "pretty_salary_range", "salaryRange", "salary_range")
          ? String(pick(j, "pretty_salary_range", "salaryRange", "salary_range"))
          : null,
        equityRange: pick(j, "pretty_equity_range", "equityRange", "equity_range")
          ? String(pick(j, "pretty_equity_range", "equityRange", "equity_range"))
          : null,
        visa: pick(j, "pretty_sponsors_visa", "sponsorsVisa", "sponsors_visa")
          ? String(pick(j, "pretty_sponsors_visa", "sponsorsVisa", "sponsors_visa"))
          : null,
        skills: skillNames(j.skills),
      };
    });

  const founders = Array.isArray(company.founders) ? company.founders : [];
  return {
    slug: String(company.slug ?? slug),
    url: companyUrl,
    name: String(company.name ?? ""),
    batch: String(company.batch ?? ""),
    tagline: String(company.one_liner ?? company.oneLiner ?? ""),
    description: String(company.description ?? ""),
    website: String(company.website ?? company.website_url ?? ""),
    location: String(company.pretty_location ?? company.location ?? ""),
    teamSize: (company.team_size as number | null) ?? null,
    industry: String(company.primary_vertical ?? company.child_sector ?? company.parent_sector ?? ""),
    isHiring: (company.is_hiring as boolean | null) ?? null,
    founders: founders.map((founder) => {
      const f = founder as Record<string, unknown>;
      const name =
        String(f.full_name ?? "") ||
        [f.first_name, f.last_name].filter(Boolean).join(" ");
      return {
        name,
        bio: String(f.founder_bio ?? ""),
        linkedin: String(f.linkedin ?? ""),
      };
    }),
    openRoles,
    fetchedAt: new Date().toISOString(),
  };
}

function jobUrl(job: Record<string, unknown>): string {
  const path = job.show_path;
  if (!path) return job.id ? `${BASE_URL}/jobs/${job.id}` : "";
  const pathStr = String(path);
  return /^https?:\/\//.test(pathStr) ? pathStr : `${BASE_URL}${pathStr}`;
}
