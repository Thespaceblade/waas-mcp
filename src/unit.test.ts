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
import { extractSkillCatalog, normalizeProfile, normalizeProfilePreview } from "./profile-client.js";
import {
  applyExperienceUpdates,
  applyShareUpdate,
  applySkillsUpdate,
  normalizeMonthDate,
  withEmptyListSentinel,
} from "./update-profile-client.js";

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

describe("waas profile parsing", () => {
  it("extracts skill catalog labels from page HTML", () => {
    const html = `[{"label":"Python","value":107},{"label":"RAG","value":326}]`;
    const catalog = extractSkillCatalog(html);
    assert.equal(catalog.get(107), "Python");
    assert.equal(catalog.get(326), "RAG");
  });

  it("normalizes experience, education, skills, and share fields", () => {
    const catalog = new Map<number, string>([
      [107, "Python"],
      [183, "Machine Learning"],
    ]);
    const profile = normalizeProfile(
      {
        id: 1,
        short_id: "abc",
        full_name: "Jason Charwin",
        shared: true,
        sectionInfo: [{ name: "experience", title: "Experience", url: "/application/experience", status: "complete" }],
        data: {
          first_name: "Jason",
          last_name: "Charwin",
          email: "jason@example.com",
          city_current: "Chapel Hill, NC",
          github: "https://github.com/Thespaceblade",
          role: "eng",
          eng_type: ["ml", "fs"],
          job_type: ["intern"],
          remote: "yes",
          short_phrase: "DS undergrad shipping ML",
          looking_for: "SWE/ML internship",
          proud_project: "Brain CNN",
          top_skills: [
            { value: 107, rating: "advanced" },
            { value: 183, rating: "advanced" },
          ],
          positions: [
            {
              id: 10,
              employer_name_other: "Wells Fargo",
              title: "Chief Data Office Intern",
              location: "Remote",
              start_date: "2026-06-01",
              end_date: "2026-08-01",
              is_current: false,
              summary: "Built data products.",
            },
          ],
          educations: [
            {
              id: 20,
              degree: "Bachelors",
              field_of_study: "Data Science",
              start_date: "2024-08-01",
              end_date: "2028-06-01",
              school: { name: "University of North Carolina at Chapel Hill" },
            },
          ],
        },
      },
      catalog,
    );

    assert.equal(profile.fullName, "Jason Charwin");
    assert.equal(profile.experience.length, 1);
    assert.equal(profile.experience[0]?.company, "Wells Fargo");
    assert.equal(profile.experience[0]?.currentlyWorkHere, false);
    assert.equal(profile.education[0]?.school, "University of North Carolina at Chapel Hill");
    assert.equal(profile.skills[0]?.name, "Python");
    assert.equal(profile.share.shortPhrase, "DS undergrad shipping ML");
    assert.deepEqual(profile.preferences.jobTypes, ["intern"]);
  });

  it("normalizes company-facing preview payload", () => {
    const catalog = new Map<number, string>([[107, "Python"]]);
    const preview = normalizeProfilePreview(
      {
        cid: "aAhTm6Hk",
        data_type: "full_candidate",
        profile_meta: { id: 1, short_id: "aAhTm6Hk" },
        data: {
          first_name: "Jason",
          last_name: "Charwin",
          city_current: "Chapel Hill, NC, USA",
          pretty_role: "Engineering",
          pretty_subtype: "Data science, Machine learning",
          experienceDisplay: "<1 year",
          grad_date_display: "Graduates Jun 2028",
          short_phrase: "DS undergrad",
          looking_for: "SWE/ML internship",
          proud_project: "Brain CNN",
          pretty_positions: "Intern at Wells Fargo",
          pretty_educations: "Data Science at UNC",
          github: "https://github.com/Thespaceblade",
          avatar_thumb: "https://example.com/avatar.jpg",
          top_skills: [{ value: 107, rating: "advanced" }],
          positions: [
            {
              id: 10,
              employer_name_other: "Wells Fargo",
              title: "Intern",
              is_current: false,
            },
          ],
          educations: [
            {
              id: 20,
              field_of_study: "Data Science",
              school: { name: "UNC" },
            },
          ],
        },
      },
      catalog,
    );

    assert.equal(preview.fullName, "Jason Charwin");
    assert.equal(preview.headline.role, "Engineering");
    assert.equal(preview.pretty.positions, "Intern at Wells Fargo");
    assert.equal(preview.skills[0]?.name, "Python");
    assert.equal(preview.share.shortPhrase, "DS undergrad");
  });
});

describe("waas profile updates", () => {
  it("normalizes month dates to YYYY-MM-01", () => {
    assert.equal(normalizeMonthDate("2028-06"), "2028-06-01");
    assert.equal(normalizeMonthDate("2028-06-15"), "2028-06-01");
    assert.equal(normalizeMonthDate(null), null);
  });

  it("uses [_] sentinel for empty lists", () => {
    assert.deepEqual(withEmptyListSentinel([]), ["_"]);
    assert.deepEqual(withEmptyListSentinel([{ id: 1 }]), [{ id: 1 }]);
  });

  it("patches experience, clears end_date when currently working, and updates education", () => {
    const result = applyExperienceUpdates(
      [
        {
          id: 1,
          employer_name_other: "Wells Fargo",
          title: "Intern",
          start_date: "2026-06-01",
          end_date: "2026-08-01",
          is_current: false,
        },
        {
          id: 2,
          employer_name_other: "Old Co",
          title: "Weak",
          start_date: "2020-01-01",
          end_date: "2020-06-01",
          is_current: false,
        },
      ],
      [
        {
          id: 10,
          degree: "Bachelors",
          field_of_study: "Data Science",
          start_date: "2024-08-01",
          end_date: "2027-05-01",
          school: { id: 8846, name: "UNC" },
        },
      ],
      {
        mode: "patch",
        remove_ids: [2],
        positions: [
          {
            id: 1,
            currently_work_here: true,
            title: "Chief Data Office Intern",
          },
          {
            company: "Zhang Lab",
            title: "Researcher",
            start_date: "2025-01",
            currently_work_here: true,
            summary: "ML research",
          },
        ],
      },
      { end_date: "2028-06" },
    );

    assert.equal(result.changed, true);
    assert.equal(result.positions.length, 2);
    assert.equal(result.positions[0]?.is_current, true);
    assert.equal(result.positions[0]?.end_date, null);
    assert.equal(result.positions[0]?.title, "Chief Data Office Intern");
    assert.equal(result.positions[1]?.employer_name_other, "Zhang Lab");
    assert.equal(result.positions[1]?.temp_id != null, true);
    assert.equal(result.educations[0]?.end_date, "2028-06-01");
  });

  it("replaces skills by name via catalog", () => {
    const catalog = new Map<number, string>([
      [107, "Python"],
      [183, "Machine Learning"],
    ]);
    const result = applySkillsUpdate([{ value: 99, rating: "beginner" }], catalog, {
      mode: "replace",
      items: [
        { name: "Python", rating: "advanced" },
        { id: 183, rating: "intermediate" },
      ],
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.top_skills, [
      { value: 107, rating: "advanced" },
      { value: 183, rating: "intermediate" },
    ]);
  });

  it("builds share payload without clearing companion fields", () => {
    const result = applyShareUpdate(
      {
        short_phrase: "old",
        looking_for: "old looking",
        proud_project: "old proud",
        share: "yes",
        waas_event_apply: null,
      },
      { short_phrase: "new phrase" },
    );
    assert.equal(result.changed, true);
    assert.equal(result.data.short_phrase, "new phrase");
    assert.equal(result.data.looking_for, "old looking");
    assert.equal(result.data.share, "yes");
    assert.equal(result.data.waas_event_apply, null);
  });
});
