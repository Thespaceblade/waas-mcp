import { inspectApplication } from "./inspect.js";
import { markApplied } from "../tracker.js";
import { withBrowser } from "../session.js";
import { BASE_URL } from "../waas.js";
import { gotoAndReadInertia } from "./inertia.js";
import { parseApplyErrorBody, resolveWeeklyQuotaStatus } from "../quota.js";
import { appliedControl, openApplyModal } from "./apply-controls.js";
import { fillAnswers } from "./fill-answers.js";

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
      await openApplyModal(page);
      await fillAnswers(page, answers, inspection.fields);

      const dialog = page.getByRole("dialog");
      const sendScope = (await dialog.count()) > 0 ? dialog : page;
      const send = sendScope.getByRole("button", { name: /^Send$/ }).first();
      if ((await send.count()) === 0) {
        if ((await appliedControl(page).count()) > 0) {
          return {
            jobId,
            dryRun: false,
            submitted: false,
            alreadyApplied: true,
            answers,
            warnings: ["Apply button missing — likely already applied."],
          };
        }
        throw new Error("Could not find Send button in application modal.");
      }

      if (!(await send.isEnabled())) {
        throw new Error(
          "Send button is disabled. Custom-question applications require a message (50+ characters) plus all required fields.",
        );
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
    if (field.name === "message" && String(value).trim().length < 50) {
      throw new Error(
        `Message must be at least 50 characters for Work at a Startup (${String(value).trim().length} provided).`,
      );
    }
  }
}
