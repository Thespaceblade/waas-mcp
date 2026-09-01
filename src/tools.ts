import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectApplication } from "./browser/inspect.js";
import { searchJobs } from "./browser/search.js";
import { submitApplication } from "./browser/submit.js";
import { checkSessionValid } from "./session.js";
import { fetchCompany } from "./company-client.js";
import { fetchJobPosting } from "./job-client.js";
import { loadApplied } from "./tracker.js";
import { resolveWeeklyQuotaStatus } from "./quota.js";
import { parseCompanySlug, parseJobId } from "./waas.js";

export const WORKFLOW = `
WORKFLOW (required):
1. waas_application_quota (or waas_search weeklyQuota) — check remaining in-app applications this week (cap is 10).
2. waas_search with structured filters (or waas_get_job from a URL the user provides).
3. waas_get_job + waas_get_company for full context.
4. waas_inspect_application — returns applicationType, fields[], weeklyQuota, applyBlocked.
5. If applicationType=weekly_limit_reached or applyBlocked=true → stop; do NOT submit.
6. If applicationType=external → report link/email to user; do NOT auto-submit.
7. If applicationType=needs_login → tell user to run npm run login.
8. Draft answers for every required field in fields[].
9. waas_submit_application with dry_run=true — show the user all answers.
10. Only after explicit approval → dry_run=false.
Never auto-submit. Skip already_applied jobs.
`.trim();

export function registerWaasTools(server: McpServer): void {
  server.registerTool(
    "waas_auth_status",
    {
      title: "Check login session",
      description: "Check Work at a Startup login session (~/.waas-mcp/storage-state.json or cookie.txt).",
    },
    async () => toolOk(await checkSessionValid()),
  );

  server.registerTool(
    "waas_application_quota",
    {
      title: "Weekly application quota",
      description:
        "Check Work at a Startup weekly in-app application cap (10/week). Counts candidate messages since Monday from /api/conversations, merged with ~/.waas-mcp/applied.json for recent MCP submits.",
    },
    async () => {
      try {
        return toolOk(await resolveWeeklyQuotaStatus());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_search",
    {
      title: "Search jobs",
      description: `Search YC Work at a Startup jobs with structured filters. Builds the search URL automatically. ${WORKFLOW}`,
      inputSchema: {
        role: z
          .enum([
            "eng",
            "design",
            "product",
            "sales",
            "marketing",
            "operations",
            "recruiting",
            "science",
            "legal",
            "finance",
          ])
          .optional()
          .describe("Role category filter."),
        query: z.string().optional().describe("Keyword search."),
        remote: z.boolean().optional().describe("true = remote only, false = on-site only."),
        job_type: z.enum(["fulltime", "intern", "cofounder", "contract"]).optional(),
        us_visa: z.enum(["yes", "no", "any"]).optional(),
        has_salary: z.boolean().optional(),
        has_equity: z.boolean().optional(),
        sort_by: z.enum(["created_desc", "created_asc", "company_name"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 30)."),
      },
    },
    async (filters) => {
      try {
        const { limit, ...searchFilters } = filters;
        return toolOk(await searchJobs(searchFilters, { limit: limit ?? 30 }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_get_job",
    {
      title: "Get job posting",
      description: `Fetch full job posting (description, comp, visa, skills). Works logged out for public pages. ${WORKFLOW}`,
      inputSchema: {
        job_id: z.string().describe("Numeric id or /jobs/123 URL."),
      },
    },
    async ({ job_id }) => {
      try {
        return toolOk(await fetchJobPosting(parseJobId(job_id)));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_get_company",
    {
      title: "Get company profile",
      description: "Fetch company profile, founders, and open roles.",
      inputSchema: {
        slug: z.string().describe("Company slug or /companies/acme URL."),
      },
    },
    async ({ slug }) => {
      try {
        return toolOk(await fetchCompany(parseCompanySlug(slug)));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_inspect_application",
    {
      title: "Inspect application form",
      description: `Inspect how to apply: returns applicationType, required fields (message, resume URL, multiple choice, etc.), external apply hints, and whether you're already applied. ${WORKFLOW}`,
      inputSchema: {
        job_id: z.string().describe("Numeric id or /jobs/123 URL."),
      },
    },
    async ({ job_id }) => {
      try {
        return toolOk(await inspectApplication(parseJobId(job_id)));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_submit_application",
    {
      title: "Submit application",
      description: `Submit application answers. Pass a map of field names → values (see waas_inspect_application fields). Default dry_run=true. ${WORKFLOW}`,
      inputSchema: {
        job_id: z.string(),
        answers: z
          .record(z.union([z.string(), z.number()]))
          .describe(
            'Field answers, e.g. { "message": "...", "question_1981": "...", "question_2839": "https://..." }',
          ),
        dry_run: z.boolean().optional().describe("Default true — preview only."),
      },
    },
    async ({ job_id, answers, dry_run }) => {
      try {
        return toolOk(await submitApplication(parseJobId(job_id), answers, dry_run ?? true));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_list_applied",
    {
      title: "List applied jobs",
      description: "List jobs you've submitted via this MCP (local tracker at ~/.waas-mcp/applied.json).",
    },
    async () => toolOk({ applied: loadApplied() }),
  );
}

function toolError(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

function toolOk(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
