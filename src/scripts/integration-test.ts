import { inspectApplication } from "../browser/inspect.js";
import { searchJobs } from "../browser/search.js";
import { submitApplication } from "../browser/submit.js";
import { fetchJobPosting } from "../job-client.js";

async function findJobWithCustomQuestions(
  preferredId?: string,
): Promise<string> {
  if (preferredId) return preferredId;

  const search = await searchJobs({ role: "eng" }, { limit: 20 });
  for (const hit of search.hits) {
    const inspection = await inspectApplication(hit.jobId);
    if (inspection.fields.length > 0) return hit.jobId;
  }
  return "99221";
}

async function main() {
  console.log("=== WaaS MCP live integration test ===\n");

  console.log("1) waas_search (eng roles)...");
  const search = await searchJobs({ role: "eng", sort_by: "created_desc" }, { limit: 5 });
  console.log(`   ${search.totalHits} hits, url: ${search.searchUrl}`);
  if (search.hits.length === 0) throw new Error("No search hits");
  search.hits.slice(0, 3).forEach((h) => console.log(`   - ${h.jobId} ${h.jobTitle} @ ${h.companyName}`));

  const targetId = await findJobWithCustomQuestions(process.argv[2]);
  console.log(`\n2) waas_get_job (${targetId})...`);
  const job = await fetchJobPosting(targetId);
  console.log(`   ${job.title} @ ${job.company}`);

  console.log(`\n3) waas_inspect_application (${targetId})...`);
  const inspection = await inspectApplication(targetId);
  console.log(`   type: ${inspection.applicationType}`);
  console.log(`   fields (${inspection.fields.length}):`);
  inspection.fields.forEach((f) =>
    console.log(`     - [${f.type}] ${f.label}${f.required ? " *" : ""}`),
  );
  inspection.notes.forEach((n) => console.log(`   note: ${n}`));

  const answers: Record<string, string> = {};
  for (const field of inspection.fields) {
    if (field.type === "message" || field.type === "long_text" || field.type === "text") {
      answers[field.name] = "[DRY RUN] Excited about this role — integration test message.";
    } else if (field.type === "url") {
      answers[field.name] = "https://example.com/resume.pdf";
    } else if (field.type === "multiple_choice" && field.options?.[0]) {
      answers[field.name] = field.options[0].label;
    }
  }

  console.log(`\n4) waas_submit_application dry_run...`);
  const dry = await submitApplication(targetId, answers, true);
  console.log(`   dryRun=${dry.dryRun} submitted=${dry.submitted}`);
  dry.warnings.forEach((w) => console.log(`   warning: ${w}`));

  console.log("\n=== Integration test complete ===");
  if (!inspection.loggedIn) {
    console.log("Note: run `npm run login` to enable real submissions.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
