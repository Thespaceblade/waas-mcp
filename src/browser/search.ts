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

const ALGOLIA_INDEX_BY_SORT: Record<NonNullable<WaasSearchFilters["sort_by"]>, string> = {
  created_desc: "WaaSPublicCompanyJob_created_at_desc_production",
  created_asc: "WaaSPublicCompanyJob_created_at_asc_production",
  company_name: "WaaSPublicCompanyJob_company_name_production",
};

/** Public `/jobs` listing ignores jobType; filtered search uses the companies directory + Algolia. */
function shouldUseCompaniesDirectory(filters: WaasSearchFilters): boolean {
  return Boolean(
    filters.job_type ||
      filters.query ||
      filters.remote !== undefined ||
      filters.us_visa ||
      filters.has_salary !== undefined ||
      filters.has_equity !== undefined,
  );
}

export async function searchJobs(
  filters: WaasSearchFilters,
  options?: { limit?: number; preferCompanies?: boolean },
): Promise<SearchResults> {
  const limit = options?.limit ?? 50;
  const weeklyQuota = hasSession()
    ? await resolveWeeklyQuotaStatus().catch(() => undefined)
    : undefined;

  if (options?.preferCompanies || shouldUseCompaniesDirectory(filters)) {
    try {
      const companiesResults = await searchCompaniesDirectory(filters, limit);
      if (companiesResults.hits.length > 0 || shouldUseCompaniesDirectory(filters)) {
        return finalizeResults(companiesResults, filters, limit, weeklyQuota, false);
      }
    } catch {
      // Fall through to public jobs listing.
    }
  }

  const jobsUrl = buildJobsSearchUrl(filters);
  const publicResults = await fetchJobsListing(jobsUrl);
  return finalizeResults(publicResults, filters, limit, weeklyQuota, true);
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

async function searchCompaniesDirectory(
  filters: WaasSearchFilters,
  limit: number,
): Promise<SearchResults> {
  const companiesUrl = buildCompaniesSearchUrl(filters);
  const runner = hasSession() ? withBrowser : withPublicBrowser;

  return runner(async (page) => {
    let apiKey = "";
    let appId = "";
    page.on("request", (request) => {
      if (!request.url().includes("algolia.net")) return;
      try {
        const url = new URL(request.url());
        appId = url.searchParams.get("x-algolia-application-id") || appId;
        apiKey = url.searchParams.get("x-algolia-api-key") || apiKey;
      } catch {
        // ignore
      }
    });

    await page.goto(companiesUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForRequest((request) => request.url().includes("algolia.net"), { timeout: 15_000 });
    } catch {
      // Credentials may already be on window.AlgoliaOpts without a network call.
    }
    await page.waitForTimeout(500);

    if (!appId || !apiKey) {
      const fromWindow = await page.evaluate(() => {
        const opts = (window as unknown as { AlgoliaOpts?: { app?: string; key?: string } }).AlgoliaOpts;
        return { appId: opts?.app ?? "", apiKey: opts?.key ?? "" };
      });
      appId = fromWindow.appId;
      apiKey = fromWindow.apiKey;
    }

    if (!appId || !apiKey) {
      throw new Error("Could not load Algolia credentials from WaaS companies directory.");
    }

    const indexName = ALGOLIA_INDEX_BY_SORT[filters.sort_by ?? "created_desc"];
    const algoliaFilters = buildAlgoliaFilters(filters);
    const hitsPerPage = Math.min(Math.max(limit, 1), 100);

    const payload = {
      requests: [
        {
          indexName,
          params: new URLSearchParams({
            query: filters.query ?? "",
            page: "0",
            ...(algoliaFilters ? { filters: algoliaFilters } : {}),
            hitsPerPage: String(hitsPerPage),
            clickAnalytics: "true",
          }).toString(),
        },
      ],
    };

    const json = await page.evaluate(
      async ({ appId, apiKey, payload }) => {
        const endpoint =
          `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries` +
          `?x-algolia-agent=${encodeURIComponent("Algolia for JavaScript (3.35.1); Browser")}` +
          `&x-algolia-application-id=${encodeURIComponent(appId)}` +
          `&x-algolia-api-key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`Algolia search failed (${response.status})`);
        }
        return response.json();
      },
      { appId, apiKey, payload },
    );

    const result = (json as { results?: Array<{ hits?: unknown[]; nbHits?: number }> }).results?.[0];
    const rawHits = Array.isArray(result?.hits) ? result!.hits! : [];
    const hits = rawHits.map((raw) => mapAlgoliaHit(raw as Record<string, unknown>));
    const loggedIn = hasSession() ? await isLoggedInPage(page) : false;

    return {
      searchUrl: companiesUrl,
      loggedIn,
      totalHits: typeof result?.nbHits === "number" ? result.nbHits : hits.length,
      hits,
      fetchedAt: new Date().toISOString(),
    };
  });
}

export function buildAlgoliaFilters(filters: WaasSearchFilters): string {
  const parts: string[] = [];
  if (filters.role) parts.push(`(role:${filters.role})`);
  if (filters.job_type) parts.push(`(job_type:"${filters.job_type}")`);
  if (filters.remote === true) parts.push(`(remote:"yes" OR remote:"only")`);
  if (filters.remote === false) parts.push(`(remote:"no")`);
  if (filters.us_visa === "yes") parts.push(`(us_visa_required:"yes")`);
  if (filters.us_visa === "no") parts.push(`(us_visa_required:"no")`);
  if (filters.has_salary === true) parts.push(`(has_salary:true)`);
  if (filters.has_salary === false) parts.push(`(has_salary:false)`);
  if (filters.has_equity === true) parts.push(`(has_equity:true)`);
  if (filters.has_equity === false) parts.push(`(has_equity:false)`);
  return parts.join(" AND ");
}

function mapAlgoliaHit(job: Record<string, unknown>): SearchHit {
  const company = (job.company as Record<string, unknown> | undefined) ?? {};
  const id = String(job.id ?? job.objectID ?? "");
  const slug =
    String(company.slug ?? job.company_slug ?? "") ||
    slugFromSearchPath(String(job.search_path ?? ""));
  const jobTypeRaw = String(job.job_type ?? job.pretty_job_type ?? "");
  const locations = Array.isArray(job.locations_for_search)
    ? job.locations_for_search.map(String)
    : [];
  const location =
    String(
      job.pretty_location_or_remote ??
        locations[locations.length - 1] ??
        job.location ??
        "",
    ) || "";

  return {
    jobId: id,
    jobTitle: String(job.title ?? ""),
    jobUrl: id ? `${BASE_URL}/jobs/${id}` : "",
    companyName: String(company.name ?? job.company_name ?? ""),
    companySlug: slug,
    companyUrl: slug ? `${BASE_URL}/companies/${slug}` : "",
    batch: String(company.batch ?? job.company_batch ?? ""),
    location,
    role: String(
      (Array.isArray(job.eng_type) && job.eng_type[0]) ||
        job.pretty_role ||
        job.role ||
        "",
    ),
    jobType: prettyJobType(jobTypeRaw),
    salary: job.pretty_salary_range
      ? String(job.pretty_salary_range)
      : job.salary
        ? String(job.salary)
        : null,
  };
}

function slugFromSearchPath(path: string): string {
  const match = path.match(/\/companies\/([^/?#]+)/i);
  return match?.[1] ?? "";
}

function prettyJobType(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "intern" || v === "internship") return "Intern";
  if (v === "fulltime" || v === "full-time" || v === "full time") return "Full-time";
  if (v === "cofounder" || v === "co-founder") return "Co-founder";
  if (v === "contract") return "Contract";
  return value;
}

function finalizeResults(
  results: SearchResults,
  filters: WaasSearchFilters,
  limit: number,
  weeklyQuota: WeeklyQuotaStatus | undefined,
  applyClientJobTypeFilter: boolean,
): SearchResults {
  const filtered = applyClientJobTypeFilter
    ? filterHitsByJobType(results.hits, filters.job_type)
    : { hits: results.hits, note: null as string | null };
  return {
    ...results,
    hits: filtered.hits.slice(0, limit),
    totalHits: applyClientJobTypeFilter ? filtered.hits.length : results.totalHits,
    ...(filtered.note ? { filterNote: filtered.note } : {}),
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
