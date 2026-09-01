import type { Page } from "playwright";
import { inspectApplication } from "./inspect.js";
import { markApplied } from "../tracker.js";
import { withBrowser } from "../session.js";
import { BASE_URL } from "../waas.js";
import { gotoAndReadInertia } from "./inertia.js";
import { parseApplyErrorBody, resolveWeeklyQuotaStatus } from "../quota.js";

export type SubmitAnswers = Record<string, string | number>;

export type SubmitResult = {
  jobId: string;
  dryRun: boolean;
  submitted: boolean;
  alreadyApplied: boolean;
  answers: SubmitAnswers;
  warnings: string[];
  weeklyQuota?: Awaited<ReturnType<typeof resolveWeeklyQuotaStatus>>;
  responseUrl?: string;
};

export async function submitApplication(
  jobId: string,
  answers: SubmitAnswers,
  dryRun = true,
): Promise<SubmitResult> {
  const inspection = await inspectApplication(jobId);
  const warnings = [...inspection.notes];

  if (inspection.applyBlocked || inspection.applicationType === "weekly_limit_reached") {
    const weeklyQuota =
      inspection.weeklyQuota ?? (await resolveWeeklyQuotaStatus().catch(() => undefined));
    return {
      jobId,
      dryRun,
      submitted: false,
      alreadyApplied: false,
      answers,
      weeklyQuota,
      warnings: [
        ...warnings,
        weeklyQuota?.applyBlockedReason ?? "Weekly application cap reached on Work at a Startup.",
        "Cannot submit while the weekly cap is reached.",
      ],
    };
  }

  if (inspection.alreadyApplied) {
    return {
      jobId,
      dryRun,
      submitted: false,
      alreadyApplied: true,
      answers,
      warnings: [...warnings, "Already applied — skipped."],
    };
  }

  if (inspection.applicationType === "external") {
    return {
      jobId,
      dryRun,
      submitted: false,
      alreadyApplied: false,
      answers,
      warnings: [
        ...warnings,
        inspection.external.instructions ?? "External application required.",
        "Cannot auto-submit external applications.",
      ],
    };
  }

  if (!inspection.canAutoSubmit && !dryRun) {
    throw new Error("Login required. Run npm run login in waas-mcp.");
  }

  validateAnswers(inspection, answers);

  if (dryRun) {
    const weeklyQuota = inspection.weeklyQuota;
    return {
      jobId,
      dryRun: true,
      submitted: false,
      alreadyApplied: false,
      answers,
      weeklyQuota,
      warnings: [
        ...warnings,
        "Dry run — no submission made.",
        `Would fill ${Object.keys(answers).length} field(s).`,
        ...(weeklyQuota ? [weeklyQuota.message] : []),
      ],
    };
  }

  return withBrowser(
    async (page) => {
      await gotoAndReadInertia(page, `${BASE_URL}/jobs/${jobId}`);

      const apply = page.getByRole("link", { name: /^Apply$/ }).first();
      if ((await apply.count()) === 0) {
        const applied = page.getByRole("link", { name: /^Applied$/ }).first();
        if ((await applied.count()) > 0) {
          return {
            jobId,
            dryRun: false,
            submitted: false,
            alreadyApplied: true,
            answers,
            warnings: ["Apply button missing — likely already applied."],
          };
        }
        throw new Error("Could not find Apply button on job page.");
      }

      await apply.click();
      await page.waitForTimeout(1000);
      await fillAnswers(page, answers, inspection);

      const send = page.getByRole("button", { name: /^Send$/ }).first();
      if ((await send.count()) === 0) {
        throw new Error("Could not find Send button in application modal.");
      }

      await send.click();
      await page.waitForTimeout(2000);

      const responseText = await page.evaluate(() => {
        const el = document.querySelector("[data-page]");
        return el?.getAttribute("data-page") ?? "";
      });
      const limitFromPage = parseApplyErrorBody(responseText);

      const success =
        (await page.getByRole("link", { name: /^Applied$/ }).count()) > 0 ||
        (await page.getByText(/application sent|applied/i).count()) > 0;

      if (!success && limitFromPage) {
        return {
          jobId,
          dryRun: false,
          submitted: false,
          alreadyApplied: false,
          answers,
          warnings: [limitFromPage, "Submit blocked by Work at a Startup weekly application cap."],
          responseUrl: page.url(),
        };
      }

      if (success) {
        markApplied({
          jobId,
          company: inspection.company,
          title: inspection.jobTitle,
          appliedAt: new Date().toISOString(),
        });
      }

      return {
        jobId,
        dryRun: false,
        submitted: success,
        alreadyApplied: false,
        answers,
        warnings: success ? ["Application submitted."] : ["Submit clicked but success not confirmed."],
        responseUrl: page.url(),
      };
    },
    { persistSession: true },
  );
}

function validateAnswers(
  inspection: Awaited<ReturnType<typeof inspectApplication>>,
  answers: SubmitAnswers,
): void {
  for (const field of inspection.fields) {
    if (!field.required) continue;
    const value = answers[field.name] ?? answers[field.id];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(`Missing required field: ${field.label} (${field.name})`);
    }
  }
}

async function fillAnswers(
  page: Page,
  answers: SubmitAnswers,
  inspection: Awaited<ReturnType<typeof inspectApplication>>,
): Promise<void> {
  for (const field of inspection.fields) {
    const value = answers[field.name] ?? answers[field.id];
    if (value === undefined) continue;
    const text = String(value);

    if (field.type === "message" || field.type === "long_text" || field.type === "text") {
      const textarea = page.locator("textarea").first();
      if ((await textarea.count()) > 0) {
        await textarea.fill(text);
        continue;
      }
      const input = page.locator(`input[type='text']`).first();
      if ((await input.count()) > 0) await input.fill(text);
      continue;
    }

    if (field.type === "url") {
      const input = page.locator(`input[type='url'], input[type='text']`).first();
      await input.fill(text);
      continue;
    }

    if (field.type === "multiple_choice") {
      const select = page.locator("select").first();
      if ((await select.count()) > 0) {
        await select.selectOption({ label: text }).catch(async () => {
          await select.selectOption(String(value));
        });
      }
    }
  }

  if (answers.message) {
    const message = String(answers.message);
    const textarea = page.locator("textarea");
    if ((await textarea.count()) > 0) {
      await textarea.first().fill(message);
    }
  }
}
