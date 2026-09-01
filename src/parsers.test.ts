import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCompanyPage } from "./company-client.js";
import { parseJobPage } from "./job-client.js";

const fixtures = join(import.meta.dirname, "../test/fixtures");

describe("parseJobPage", () => {
  it("parses a job posting fixture", async () => {
    const html = await readFile(join(fixtures, "job-100105.html"), "utf8");
    const job = parseJobPage(html, "100105");
    assert.equal(job.jobId, "100105");
    assert.equal(job.title, "Founding Engineer");
    assert.equal(job.company, "Siphox Health");
    assert.equal(job.companySlug, "siphox-health");
    assert.ok(job.description.length > 20);
  });
});

describe("parseCompanyPage", () => {
  it("parses open roles from a company fixture", async () => {
    const html = await readFile(join(fixtures, "company-siphox-health.html"), "utf8");
    const company = parseCompanyPage(html, "siphox-health");
    assert.equal(company.slug, "siphox-health");
    assert.equal(company.name, "Siphox Health");
    assert.ok(company.openRoles.length >= 1);
    assert.equal(company.openRoles[0]?.jobId, "100105");
  });
});
