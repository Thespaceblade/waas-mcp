import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJobsSearchUrl, filterHitsByJobType, matchesJobType } from "./filters.js";
import { detectExternalApply } from "./external-detect.js";
import { customQuestionsToFields } from "./questions.js";
import {
  applicationsThisWeek,
  buildWeeklyQuotaStatus,
  detectApplyLimitMessage,
  mergeWithLocalTracker,
  weekStartMonday,
  type WaasConversation,
} from "./quota.js";

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

describe("weekly quota", () => {
  const monday = new Date("2026-09-01T12:00:00Z");

  it("counts applications since Monday from conversations API", () => {
    const conversations: WaasConversation[] = [
      {
        id: "c1",
        has_applied: true,
        company: { id: 1, name: "Acme" },
        referenced_job_ids: [100],
        messages: [{ from_candidate: true, created_at: "2026-08-30T10:00:00Z" }],
      },
      {
        id: "c2",
        has_applied: true,
        company: { id: 2, name: "Beta" },
        referenced_job_ids: [200],
        messages: [{ from_candidate: true, created_at: "2026-09-02T10:00:00Z" }],
      },
    ];

    const apps = applicationsThisWeek(conversations, monday);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]?.company, "Beta");
  });

  it("counts re-applies in existing company threads this week", () => {
    const conversations: WaasConversation[] = [
      {
        id: "lambda-robotics",
        has_applied: true,
        company: { id: 1, name: "Lambda Robotics" },
        referenced_job_ids: [102288, 102289],
        messages: [
          { from_candidate: true, created_at: "2026-08-09T02:35:21.971Z" },
          { from_candidate: true, created_at: "2026-09-01T19:36:50.409Z" },
        ],
      },
    ];

    const apps = applicationsThisWeek(conversations, monday);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]?.company, "Lambda Robotics");
    assert.equal(apps[0]?.appliedAt, "2026-09-01T19:36:50.409Z");
  });

  it("merges local tracker submissions missing from conversations API", () => {
    const conversations: WaasConversation[] = [
      {
        id: "the-subvocal-company",
        has_applied: true,
        company: { id: 2, name: "The Subvocal Company" },
        referenced_job_ids: [107082],
        messages: [{ from_candidate: true, created_at: "2026-09-01T18:53:39.191Z" }],
      },
    ];

    const { applications, addedFromTracker } = mergeWithLocalTracker(
      applicationsThisWeek(conversations, monday),
      monday,
      [
        {
          jobId: "102288",
          company: "Lambda Robotics",
          title: "Electrical Engineer, Robotics",
          appliedAt: "2026-09-01T19:36:52.357Z",
        },
      ],
    );

    assert.equal(addedFromTracker, 1);
    assert.equal(applications.length, 2);
    assert.ok(applications.some((app) => app.conversationId === "local:102288"));
  });

  it("builds atLimit status when cap reached", () => {
    const conversations: WaasConversation[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      has_applied: true,
      company: { id: i, name: `Co${i}` },
      referenced_job_ids: [i],
      messages: [{ from_candidate: true, created_at: "2026-09-02T10:00:00Z" }],
    }));

    const status = buildWeeklyQuotaStatus(conversations, {
      reference: monday,
      cap: 10,
      localRecords: [],
    });
    assert.equal(status.used, 10);
    assert.equal(status.atLimit, true);
    assert.equal(status.remaining, 0);
    assert.match(status.message, /cap reached/i);
    assert.match(status.applyBlockedReason ?? "", /10 applications per week/);
  });

  it("week starts on Monday", () => {
    const monday = new Date(2026, 8, 7, 12, 0, 0); // Sep 7 2026 is a Monday
    const start = weekStartMonday(monday);
    assert.equal(start.getDay(), 1);
    assert.equal(start.getDate(), 7);
    assert.equal(start.getHours(), 0);
  });

  it("detects limit messages in UI copy", () => {
    const msg = detectApplyLimitMessage(
      "You have reached the maximum number of applications per week. Try again next Monday.",
    );
    assert.ok(msg);
    assert.match(msg, /applications per week/i);
  });
});
