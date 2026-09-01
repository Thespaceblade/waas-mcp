import { BASE_URL } from "./waas.js";

export type WaasSearchFilters = {
  role?: "eng" | "design" | "product" | "sales" | "marketing" | "operations" | "recruiting" | "science" | "legal" | "finance";
  role_path?: string;
  query?: string;
  remote?: boolean;
  job_type?: "fulltime" | "intern" | "cofounder" | "contract";
  us_visa?: "yes" | "no" | "any";
  has_salary?: boolean;
  has_equity?: boolean;
  layout?: "list-compact" | "list";
  sort_by?: "created_desc" | "created_asc" | "company_name";
};

const ROLE_PATHS: Record<NonNullable<WaasSearchFilters["role"]>, string> = {
  eng: "/jobs/l/software-engineer",
  design: "/jobs/l/designer",
  product: "/jobs/l/product-manager",
  sales: "/jobs/l/sales-manager",
  marketing: "/jobs/l/marketing",
  operations: "/jobs/l/operations",
  recruiting: "/jobs/l/recruiting",
  science: "/jobs/l/science",
  legal: "/jobs/l/legal",
  finance: "/jobs/l/finance",
};

export function buildJobsSearchUrl(filters: WaasSearchFilters = {}): string {
  if (filters.role_path) {
    const path = filters.role_path.startsWith("/") ? filters.role_path : `/${filters.role_path}`;
    return `${BASE_URL}${path}${buildQuerySuffix(filters, true)}`;
  }

  const params = new URLSearchParams();
  if (filters.role) params.set("role", filters.role);
  if (filters.query) params.set("query", filters.query);
  if (filters.remote === true) params.set("remote", "yes");
  if (filters.remote === false) params.set("remote", "no");
  if (filters.job_type) params.set("jobType", filters.job_type);
  if (filters.us_visa) params.set("usVisa", filters.us_visa);
  if (filters.has_salary === true) params.set("hasSalary", "yes");
  if (filters.has_salary === false) params.set("hasSalary", "no");
  if (filters.has_equity === true) params.set("hasEquity", "yes");
  if (filters.has_equity === false) params.set("hasEquity", "no");
  if (filters.layout) params.set("layout", filters.layout);
  if (filters.sort_by) params.set("sortBy", filters.sort_by);

  const qs = params.toString();
  return `${BASE_URL}/jobs${qs ? `?${qs}` : ""}`;
}

export function buildCompaniesSearchUrl(filters: WaasSearchFilters = {}): string {
  const params = new URLSearchParams({
    demographic: "any",
    hasEquity: filters.has_equity === false ? "no" : filters.has_equity === true ? "yes" : "any",
    hasSalary: filters.has_salary === false ? "no" : filters.has_salary === true ? "yes" : "any",
    industry: "any",
    interviewProcess: "any",
    jobType: filters.job_type ?? "any",
    layout: filters.layout ?? "list-compact",
    sortBy: filters.sort_by ?? "created_desc",
    tab: "any",
    usVisa: filters.us_visa ?? "any",
  });
  if (filters.role) params.set("role", filters.role);
  if (filters.query) params.set("query", filters.query);
  if (filters.remote === true) params.set("remote", "yes");
  if (filters.remote === false) params.set("remote", "no");
  return `${BASE_URL}/companies?${params.toString()}`;
}

export function rolePathFor(role: WaasSearchFilters["role"]): string | undefined {
  return role ? ROLE_PATHS[role] : undefined;
}

function buildQuerySuffix(filters: WaasSearchFilters, skipRole: boolean): string {
  const params = new URLSearchParams();
  if (!skipRole && filters.role) params.set("role", filters.role);
  if (filters.query) params.set("query", filters.query);
  if (filters.remote === true) params.set("remote", "yes");
  if (filters.remote === false) params.set("remote", "no");
  if (filters.job_type) params.set("jobType", filters.job_type);
  if (filters.layout) params.set("layout", filters.layout);
  if (filters.sort_by) params.set("sortBy", filters.sort_by);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

const JOB_TYPE_PATTERNS: Record<NonNullable<WaasSearchFilters["job_type"]>, RegExp> = {
  fulltime: /^full\s*time$/i,
  intern: /^intern(ship)?$/i,
  cofounder: /^co[- ]?founder$/i,
  contract: /^contract$/i,
};

export function matchesJobType(
  jobTypeLabel: string,
  filter: NonNullable<WaasSearchFilters["job_type"]>,
): boolean {
  return JOB_TYPE_PATTERNS[filter].test(jobTypeLabel.trim());
}

export function filterHitsByJobType<T extends { jobType: string }>(
  hits: T[],
  jobType?: WaasSearchFilters["job_type"],
): { hits: T[]; note: string | null } {
  if (!jobType) return { hits, note: null };
  const filtered = hits.filter((hit) => matchesJobType(hit.jobType, jobType));
  if (filtered.length === hits.length) return { hits, note: null };
  return {
    hits: filtered,
    note: `job_type="${jobType}" tightened client-side (${hits.length} from WaaS → ${filtered.length} matched).`,
  };
}
