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
import { fetchWaasProfile, fetchWaasProfilePreview } from "./profile-client.js";
import { updateWaasProfile } from "./update-profile-client.js";
import { auditWaasProfile } from "./audit-profile-client.js";
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
    "waas_get_profile",
    {
      title: "Get my WAAS profile",
      description:
        "Fetch your live Work at a Startup candidate profile: experience, education, skills, share copy (short_phrase / looking_for / proud_project), and role/location preferences. Requires login.",
    },
    async () => {
      try {
        return toolOk(await fetchWaasProfile());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_preview_profile",
    {
      title: "Preview company-facing profile",
      description:
        "Fetch the founder/company-facing rendering of your WAAS profile (same data as the in-app Preview iframe): headline, share copy, pretty experience/education strings, skills, and links. Use after edits to QA without asking the user to click Preview. Requires login.",
    },
    async () => {
      try {
        return toolOk(await fetchWaasProfilePreview());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_update_profile",
    {
      title: "Update WAAS profile",
      description:
        "Write Experience/Education, Skills, and/or Share fields on your Work at a Startup profile. dry_run=true by default — returns a before/after diff and planned POSTs. Only set dry_run=false after explicit user approval. Requires login.",
      inputSchema: {
        dry_run: z.boolean().optional().describe("Default true — preview diff only; no writes."),
        experience: z
          .object({
            mode: z.enum(["replace", "patch"]).optional().describe("replace = full ordered list; patch = upsert by id / append."),
            positions: z
              .array(
                z.object({
                  id: z.number().optional().describe("Existing experience id; omit to create."),
                  company: z.string().optional(),
                  title: z.string().optional(),
                  location: z.string().nullable().optional(),
                  start_date: z.string().nullable().optional().describe("YYYY-MM or YYYY-MM-01"),
                  end_date: z.string().nullable().optional(),
                  currently_work_here: z.boolean().optional(),
                  summary: z.string().nullable().optional(),
                }),
              )
              .optional(),
            remove_ids: z.array(z.number()).optional(),
            order: z.array(z.number()).optional().describe("Reorder by existing experience ids."),
          })
          .optional(),
        education: z
          .object({
            id: z.number().optional(),
            school: z.string().optional(),
            degree: z.string().nullable().optional(),
            field_of_study: z.string().nullable().optional(),
            start_date: z.string().nullable().optional(),
            end_date: z.string().nullable().optional().describe("e.g. 2028-06 for Jun 2028"),
            summary: z.string().nullable().optional(),
          })
          .optional(),
        skills: z
          .object({
            mode: z.literal("replace").optional(),
            items: z
              .array(
                z.object({
                  id: z.number().optional().describe("Catalog skill id from waas_get_profile"),
                  name: z.string().optional().describe("Resolved via skill catalog if id omitted"),
                  rating: z.enum(["beginner", "intermediate", "advanced"]),
                }),
              )
              .max(10),
          })
          .optional(),
        share: z
          .object({
            short_phrase: z.string().optional(),
            looking_for: z.string().optional(),
            proud_project: z.string().optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      try {
        return toolOk(await updateWaasProfile(args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "waas_audit_profile",
    {
      title: "Audit WAAS profile",
      description:
        "Diagnose weak/missing/wrong profile entries. Returns gaps[], wrong_dates[], demote_or_remove[], suggested_order[], plus share/skills notes. Optional source_paths (resume/checklist markdown) and expect[] names for gap detection. Requires login.",
      inputSchema: {
        source_paths: z
          .array(z.string())
          .optional()
          .describe("Local resume/checklist/markdown paths to extract expected company/project names."),
        expect: z
          .array(z.string())
          .optional()
          .describe("Extra names that should appear on the live profile (e.g. Zhang Lab)."),
      },
    },
    async (args) => {
      try {
        return toolOk(await auditWaasProfile(args));
      } catch (error) {
        return toolError(error);
      }
    },
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
