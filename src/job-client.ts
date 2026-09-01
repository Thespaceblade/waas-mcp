import {
  BASE_URL,
  fetchPage,
  htmlToText,
  pick,
  readInertiaPage,
  skillNames,
} from "./waas.js";
import { fetchPublicPageHtml } from "./browser/page-html.js";
import { hasSession } from "./config.js";

export type JobPosting = {
  jobId: string;
  url: string;
  title: string;
  company: string;
  companySlug: string;
  companyUrl: string;
  location: string;
  remote: boolean | null;
  jobType: string;
  role: string;
  minExperience: string | null;
  salaryRange: string | null;
  equityRange: string | null;
  visa: string | null;
  skills: string[];
  locationEligible: boolean | null;
  postedAt: string | null;
  description: string;
  fetchedAt: string;
};

export async function fetchJobPosting(jobId: string): Promise<JobPosting> {
  let html: string;
  try {
    if (hasSession()) {
      const result = await fetchPage(`/jobs/${jobId}`);
      if (!result.response.ok) {
        throw new Error(`Unexpected ${result.response.status} response while loading job ${jobId}.`);
      }
      html = result.html;
    } else {
      throw new Error("no session");
    }
  } catch {
    html = await fetchPublicPageHtml(`/jobs/${jobId}`);
  }
  return parseJobPage(html, jobId);
}

export function parseJobPage(html: string, jobId: string): JobPosting {
  const jobUrl = `${BASE_URL}/jobs/${jobId}`;
  const page = readInertiaPage(html);
  const job = page?.props?.job as Record<string, unknown> | undefined;
  if (!job) {
    throw new Error(
      `Couldn't find job data on the page for ${jobId}. Work at a Startup may have changed its markup.`,
    );
  }

  const company = (page?.props?.company ?? {}) as Record<string, unknown>;
  const companySlug = String(pick(company, "slug") ?? "");

  return {
    jobId: String(job.id ?? jobId),
    url: jobUrl,
    title: String(job.title ?? ""),
    company: String(company.name ?? ""),
    companySlug,
    companyUrl: companySlug ? `${BASE_URL}/companies/${companySlug}` : "",
    location: String(field(job, "location_or_remote") ?? field(job, "location") ?? ""),
    remote: (pick(job, "remote", "is_remote") as boolean | null) ?? null,
    jobType: String(field(job, "job_type") ?? ""),
    role: String(field(job, "role") ?? ""),
    minExperience: field(job, "min_experience") ? String(field(job, "min_experience")) : null,
    salaryRange: field(job, "salary_range") ? String(field(job, "salary_range")) : null,
    equityRange: field(job, "equity_range") ? String(field(job, "equity_range")) : null,
    visa: field(job, "sponsors_visa") ? String(field(job, "sponsors_visa")) : null,
    skills: skillNames(job.skills),
    locationEligible: (page?.props?.locationEligible as boolean | null) ?? null,
    postedAt: pick(job, "createdAt", "created_at", "postedAt", "posted_at")
      ? String(pick(job, "createdAt", "created_at", "postedAt", "posted_at"))
      : null,
    description: htmlToText(String(field(job, "description_html") ?? job.description ?? "")),
    fetchedAt: new Date().toISOString(),
  };
}

function field(job: Record<string, unknown>, name: string): unknown {
  const camelCase = name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase());
  const pascalCase = camelCase[0].toUpperCase() + camelCase.slice(1);
  return pick(job, `pretty${pascalCase}`, `pretty_${name}`, camelCase, name);
}
