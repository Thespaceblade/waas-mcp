#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inspectApplication } from "./browser/inspect.js";
import { searchJobs } from "./browser/search.js";
import { submitApplication } from "./browser/submit.js";
import { checkSessionValid } from "./session.js";
import { fetchCompany } from "./company-client.js";
import { fetchJobPosting } from "./job-client.js";
import { loadApplied } from "./tracker.js";
import { parseCompanySlug, parseJobId } from "./waas.js";

const server = new McpServer({
  name: "waas-mcp",
  version: "0.2.1",
});

const WORKFLOW = `
WORKFLOW (required):
1. waas_search with structured filters (or waas_get_job from a URL the user provides).
2. waas_get_job + waas_get_company for full context.
3. waas_inspect_application — returns applicationType, fields[], external hints.
4. If applicationType=external → report link/email to user; do NOT auto-submit.
5. If applicationType=needs_login → tell user to run npm run login.
6. Draft answers for every required field in fields[].
7. waas_submit_application with dry_run=true — show the user all answers.
8. Only after explicit approval → dry_run=false.
Never auto-submit. Skip already_applied jobs.
`.trim();

server.tool(
  "waas_auth_status",
  "Check Work at a Startup login session (~/.waas-mcp/storage-state.json or cookie.txt).",
  {},
  async () => {
    const status = await checkSessionValid();
    return toolOk(status);
  },
);

server.tool(
  "waas_search",
  `Search YC Work at a Startup jobs with structured filters. Builds the search URL automatically. ${WORKFLOW}`,
  {
    role: z
      .enum(["eng", "design", "product", "sales", "marketing", "operations", "recruiting", "science", "legal", "finance"])
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
  async (filters) => {
    try {
      const { limit, ...searchFilters } = filters;
      const results = await searchJobs(searchFilters, { limit: limit ?? 30 });
      return toolOk(results);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "waas_get_job",
  `Fetch full job posting (description, comp, visa, skills). Works logged out for public pages. ${WORKFLOW}`,
  { job_id: z.string().describe("Numeric id or /jobs/123 URL.") },
  async ({ job_id }) => {
    try {
      const job = await fetchJobPosting(parseJobId(job_id));
      return toolOk(job);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "waas_get_company",
  "Fetch company profile, founders, and open roles.",
  { slug: z.string().describe("Company slug or /companies/acme URL.") },
  async ({ slug }) => {
    try {
      const company = await fetchCompany(parseCompanySlug(slug));
      return toolOk(company);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "waas_inspect_application",
  `Inspect how to apply: returns applicationType, required fields (message, resume URL, multiple choice, etc.), external apply hints, and whether you're already applied. ${WORKFLOW}`,
  { job_id: z.string().describe("Numeric id or /jobs/123 URL.") },
  async ({ job_id }) => {
    try {
      const inspection = await inspectApplication(parseJobId(job_id));
      return toolOk(inspection);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "waas_submit_application",
  `Submit application answers. Pass a map of field names → values (see waas_inspect_application fields). Default dry_run=true. ${WORKFLOW}`,
  {
    job_id: z.string(),
    answers: z
      .record(z.union([z.string(), z.number()]))
      .describe('Field answers, e.g. { "message": "...", "question_1981": "...", "question_2839": "https://..." }'),
    dry_run: z.boolean().optional().describe("Default true — preview only."),
  },
  async ({ job_id, answers, dry_run }) => {
    try {
      const result = await submitApplication(parseJobId(job_id), answers, dry_run ?? true);
      return toolOk(result);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "waas_list_applied",
  "List jobs you've submitted via this MCP (local tracker at ~/.waas-mcp/applied.json).",
  {},
  async () => {
    const applied = loadApplied();
    return toolOk({ applied });
  },
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
