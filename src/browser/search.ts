import { buildCompaniesSearchUrl, buildJobsSearchUrl, filterHitsByJobType, type WaasSearchFilters } from "../filters.js";
import { hasSession } from "../config.js";
import { resolveWeeklyQuotaStatus, type WeeklyQuotaStatus } from "../quota.js";
import { isLoggedInPage, withBrowser, withPublicBrowser } from "../session.js";
import { BASE_URL } from "../waas.js";
import { gotoAndReadInertia } from "./inertia.js";

export type SearchHit = {
  jobId: string;
  jobTitle: string;
  jobUrl: string;
  companyName: string;
  companySlug: string;
  companyUrl: string;
  batch: string;
  location: string;
  role: string;
  jobType: string;
  salary: string | null;
};

export type SearchResults = {
  searchUrl: string;
  loggedIn: boolean;
  totalHits: number;
  hits: SearchHit[];
  filterNote?: string;
  weeklyQuota?: WeeklyQuotaStatus;
  fetchedAt: string;
};

export async function searchJobs(
  filters: WaasSearchFilters,
  options?: { limit?: number; preferCompanies?: boolean },
): Promise<SearchResults> {
  const limit = options?.limit ?? 50;
  const jobsUrl = buildJobsSearchUrl(filters);
  const companiesUrl = buildCompaniesSearchUrl(filters);

  const weeklyQuota = hasSession()
    ? await resolveWeeklyQuotaStatus().catch(() => undefined)
    : undefined;

  const publicResults = await fetchJobsListing(jobsUrl);

  if (publicResults.hits.length > 0) {
    return finalizeResults(publicResults, filters, limit, weeklyQuota);
  }

  if (!options?.preferCompanies) {
    return finalizeResults({ ...publicResults, hits: [], totalHits: 0 }, filters, limit, weeklyQuota);
  }

  try {
    const loggedInResults = await withBrowser(async (page) => {
      const inertia = await gotoAndReadInertia(page, companiesUrl);
      const loggedIn = await isLoggedInPage(page);
      return parseCompaniesListing(inertia, page.url(), loggedIn);
    });
    return finalizeResults(loggedInResults, filters, limit, weeklyQuota);
  } catch {
    return finalizeResults({ ...publicResults, hits: [], totalHits: 0 }, filters, limit, weeklyQuota);
  }
}

async function fetchJobsListing(jobsUrl: string): Promise<SearchResults> {
  if (hasSession()) {
    try {
      return await withBrowser(async (page) => {
        const inertia = await gotoAndReadInertia(page, jobsUrl);
        const loggedIn = await isLoggedInPage(page);
        return parseJobsListing(inertia, page.url(), loggedIn);
      });
    } catch {
      // Fall back to anonymous search.
    }
  }

  return withPublicBrowser(async (page) => {
    const inertia = await gotoAndReadInertia(page, jobsUrl);
    return parseJobsListing(inertia, page.url(), false);
  });
}

function finalizeResults(
  results: SearchResults,
  filters: WaasSearchFilters,
  limit: number,
  weeklyQuota?: WeeklyQuotaStatus,
): SearchResults {
  const { hits, note } = filterHitsByJobType(results.hits, filters.job_type);
  return {
    ...results,
    hits: hits.slice(0, limit),
    totalHits: hits.length,
    ...(note ? { filterNote: note } : {}),
    ...(weeklyQuota ? { weeklyQuota } : {}),
  };
}

function parseJobsListing(
  inertia: { props?: Record<string, unknown> } | null,
  searchUrl: string,
  loggedIn: boolean,
): SearchResults {
  const jobs = Array.isArray(inertia?.props?.jobs) ? inertia!.props!.jobs : [];
  const hits: SearchHit[] = jobs.map((raw) => {
    const job = raw as Record<string, unknown>;
    const slug = String(job.companySlug ?? "");
    const id = String(job.id ?? "");
    return {
      jobId: id,
      jobTitle: String(job.title ?? ""),
      jobUrl: id ? `${BASE_URL}/jobs/${id}` : "",
      companyName: String(job.companyName ?? ""),
      companySlug: slug,
      companyUrl: slug ? `${BASE_URL}/companies/${slug}` : "",
      batch: String(job.companyBatch ?? ""),
      location: String(job.location ?? ""),
      role: String(job.roleType ?? ""),
      jobType: String(job.jobType ?? ""),
      salary: job.salary ? String(job.salary) : null,
    };
  });

  return {
    searchUrl,
    loggedIn,
    totalHits: hits.length,
    hits,
    fetchedAt: new Date().toISOString(),
  };
}

function parseCompaniesListing(
  inertia: { props?: Record<string, unknown> } | null,
  searchUrl: string,
  loggedIn: boolean,
): SearchResults {
  const companies = Array.isArray(inertia?.props?.companies) ? inertia!.props!.companies : [];
  const hits: SearchHit[] = [];

  for (const entry of companies) {
    const company = entry as Record<string, unknown>;
    const slug = String(company.slug ?? "");
    const jobs = Array.isArray(company.jobs) ? company.jobs : [];
    if (jobs.length === 0) continue;
    for (const raw of jobs) {
      const job = raw as Record<string, unknown>;
      if (job.state && job.state !== "visible") continue;
      const id = String(job.id ?? "");
      hits.push({
        jobId: id,
        jobTitle: String(job.title ?? ""),
        jobUrl: id ? `${BASE_URL}/jobs/${id}` : "",
        companyName: String(company.name ?? ""),
        companySlug: slug,
        companyUrl: slug ? `${BASE_URL}/companies/${slug}` : "",
        batch: String(company.batch ?? ""),
        location: String(job.pretty_location_or_remote ?? job.location ?? ""),
        role: String(job.pretty_role ?? job.role ?? ""),
        jobType: String(job.pretty_job_type ?? job.job_type ?? ""),
        salary: job.pretty_salary_range ? String(job.pretty_salary_range) : null,
      });
    }
  }

  return {
    searchUrl,
    loggedIn,
    totalHits: hits.length,
    hits,
    fetchedAt: new Date().toISOString(),
  };
}
