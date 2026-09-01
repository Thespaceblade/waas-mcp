import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJobsSearchUrl, filterHitsByJobType, matchesJobType } from "./filters.js";
import { detectExternalApply } from "./external-detect.js";
import { customQuestionsToFields } from "./questions.js";

describe("buildJobsSearchUrl", () => {
  it("builds role and remote filters", () => {
    const url = buildJobsSearchUrl({ role: "eng", remote: true, sort_by: "created_desc" });
    assert.match(url, /workatastartup\.com\/jobs\?/);
    assert.match(url, /role=eng/);
    assert.match(url, /remote=yes/);
  });

  it("includes jobType on role path URLs", () => {
    const url = buildJobsSearchUrl({
      role_path: "/jobs/l/software-engineer",
      remote: true,
      job_type: "intern",
    });
    assert.match(url, /jobType=intern/);
    assert.match(url, /remote=yes/);
  });
});

describe("filterHitsByJobType", () => {
  it("keeps only internships when WaaS returns mixed types", () => {
    const hits = [
      { jobType: "Fulltime" },
      { jobType: "Intern" },
      { jobType: "Fulltime" },
    ];
    const { hits: filtered, note } = filterHitsByJobType(hits, "intern");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.jobType, "Intern");
    assert.match(note ?? "", /tightened client-side/);
  });

  it("matches fulltime labels", () => {
    assert.equal(matchesJobType("Fulltime", "fulltime"), true);
    assert.equal(matchesJobType("Intern", "fulltime"), false);
  });
});

describe("detectExternalApply", () => {
  it("detects greenhouse links", () => {
    const result = detectExternalApply("Apply at https://boards.greenhouse.io/acme/jobs/123");
    assert.equal(result.detected, true);
    assert.equal(result.type, "greenhouse");
  });
});

describe("customQuestionsToFields", () => {
  it("maps question types", () => {
    const fields = customQuestionsToFields([
      {
        id: 1,
        question_type: "url",
        label: "Resume",
        required: true,
        options: [],
      },
    ]);
    assert.equal(fields[0]?.type, "url");
    assert.equal(fields[0]?.name, "question_1");
  });
});
