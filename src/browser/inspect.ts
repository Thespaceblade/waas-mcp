import type { Page } from "playwright";
import { detectExternalApply } from "../external-detect.js";
import { hasSession } from "../config.js";
import { customQuestionsToFields, type CustomQuestion, type FormField } from "../questions.js";
import { isTrackedApplied } from "../tracker.js";
import { isLoggedInPage, withBrowser, withPublicBrowser } from "../session.js";
import { BASE_URL, htmlToText, pick } from "../waas.js";
import { gotoAndReadInertia } from "./inertia.js";

export type ApplicationInspection = {
  jobId: string;
  jobTitle: string;
  company: string;
  companySlug: string;
  companyUrl: string;
  applicationType:
    | "already_applied"
    | "needs_login"
    | "custom_questions"
    | "in_app_message"
    | "external"
    | "unknown";
  alreadyApplied: boolean;
  canAutoSubmit: boolean;
  loggedIn: boolean;
  fields: FormField[];
  external: ReturnType<typeof detectExternalApply>;
  applyUrl: string | null;
  notes: string[];
  descriptionExcerpt: string;
  fetchedAt: string;
};

export async function inspectApplication(jobId: string): Promise<ApplicationInspection> {
  const publicInspection = await withPublicBrowser(async (page) => {
    const inertia = await gotoAndReadInertia(page, `${BASE_URL}/jobs/${jobId}`);
    const loggedIn = await isLoggedInPage(page);
    const anchorState = await readApplyAnchor(page);
    return buildInspection(jobId, inertia, loggedIn, anchorState);
  });

  const needsModal =
    publicInspection.loggedIn &&
    !publicInspection.alreadyApplied &&
    publicInspection.applicationType === "in_app_message" &&
    publicInspection.fields.length === 1 &&
    publicInspection.fields[0]?.name === "message";

  if (!hasSession() || (!needsModal && publicInspection.fields.length > 0)) {
    if (hasSession() && publicInspection.fields.length > 0) {
      try {
        return await enrichWithSession(jobId, publicInspection);
      } catch {
        return publicInspection;
      }
    }
    return publicInspection;
  }

  try {
    return await withBrowser(async (page) => {
      const inertia = await gotoAndReadInertia(page, `${BASE_URL}/jobs/${jobId}`);
      const loggedIn = await isLoggedInPage(page);
      const anchorState = await readApplyAnchor(page);
      const inspection = buildInspection(jobId, inertia, loggedIn, anchorState);

      if (inspection.alreadyApplied || inspection.applicationType === "external") {
        return inspection;
      }

      if (loggedIn && inspection.fields.length <= 1) {
        const domFields = await openApplyModalAndReadFields(page);
        if (domFields.length > 0) {
          inspection.fields = domFields;
          inspection.applicationType = domFields.some((f) => f.type !== "message")
            ? "custom_questions"
            : "in_app_message";
        }
        inspection.canAutoSubmit = true;
      }

      return inspection;
    });
  } catch {
    return publicInspection;
  }
}

async function enrichWithSession(
  jobId: string,
  inspection: ApplicationInspection,
): Promise<ApplicationInspection> {
  return withBrowser(async (page) => {
    await gotoAndReadInertia(page, `${BASE_URL}/jobs/${jobId}`);
    const loggedIn = await isLoggedInPage(page);
    const anchorState = await readApplyAnchor(page);
    const alreadyApplied = inspection.alreadyApplied || anchorState.applied;

    return {
      ...inspection,
      alreadyApplied,
      loggedIn,
      canAutoSubmit:
        loggedIn &&
        !alreadyApplied &&
        inspection.applicationType !== "external" &&
        inspection.applicationType !== "already_applied",
      notes: loggedIn
        ? inspection.notes.filter((note) => !note.includes("Log in to submit"))
        : inspection.notes,
    };
  });
}

function buildInspection(
  jobId: string,
  inertia: { props?: Record<string, unknown> } | null,
  loggedIn: boolean,
  anchorState: { applied: boolean; canApply: boolean },
): ApplicationInspection {
  const props = inertia?.props ?? {};
  const job = (props.job ?? {}) as Record<string, unknown>;
  const company = (props.company ?? {}) as Record<string, unknown>;
  const title = String(job.title ?? "");
  const companyName = String(company.name ?? "");
  const companySlug = String(company.slug ?? pick(company, "companySlug") ?? "");
  const description = htmlToText(
    String(job.descriptionHtml ?? job.description ?? company.description ?? ""),
  );
  const external = detectExternalApply(description);
  const customQuestions = (props.customQuestions ?? []) as CustomQuestion[];
  let fields = customQuestionsToFields(customQuestions);
  const applyUrl = props.applyUrl ? String(props.applyUrl) : null;
  const notes: string[] = [];

  const tracked = isTrackedApplied(jobId);
  const alreadyApplied = tracked || anchorState.applied;

  let applicationType: ApplicationInspection["applicationType"] = "unknown";
  let canAutoSubmit = false;

  if (alreadyApplied) {
    applicationType = "already_applied";
    notes.push("You have already applied to this role.");
  } else if (external.detected) {
    applicationType = "external";
    notes.push(external.instructions ?? "Apply outside Work at a Startup.");
  } else if (fields.length > 0) {
    applicationType = "custom_questions";
    canAutoSubmit = loggedIn;
    notes.push("Custom application questions are listed in fields.");
    if (!loggedIn) notes.push("Log in to submit. Run npm run login.");
  } else if (!loggedIn && applyUrl?.includes("authenticate")) {
    applicationType = "needs_login";
    notes.push("Log in to apply in-app. Run npm run login.");
  } else if (loggedIn || anchorState.canApply) {
    applicationType = "in_app_message";
    canAutoSubmit = loggedIn;
    fields = defaultMessageField();
    notes.push("Default in-app message application.");
  } else {
    applicationType = "needs_login";
    notes.push("Session required to apply.");
  }

  return {
    jobId,
    jobTitle: title,
    company: companyName,
    companySlug,
    companyUrl: companySlug ? `${BASE_URL}/companies/${companySlug}` : "",
    applicationType,
    alreadyApplied,
    canAutoSubmit,
    loggedIn,
    fields,
    external,
    applyUrl,
    notes,
    descriptionExcerpt: description.slice(0, 400),
    fetchedAt: new Date().toISOString(),
  };
}

function defaultMessageField(): FormField[] {
  return [
    {
      id: "message",
      name: "message",
      label: "Message to founders",
      type: "message",
      required: true,
      maxLength: 500,
    },
  ];
}

async function readApplyAnchor(page: Page): Promise<{ applied: boolean; canApply: boolean }> {
  return page.evaluate(() => {
    for (const anchor of document.querySelectorAll("a")) {
      const t = anchor.textContent?.replace(/\s+/g, " ").trim();
      if (t === "Applied") return { applied: true, canApply: false };
      if (t === "Apply") return { applied: false, canApply: true };
    }
    return { applied: false, canApply: false };
  });
}

async function openApplyModalAndReadFields(page: Page): Promise<FormField[]> {
  const apply = page.getByRole("link", { name: /^Apply$/ }).first();
  if ((await apply.count()) === 0) return [];
  await apply.click();
  await page.waitForTimeout(1000);

  return page.evaluate(() => {
    const fields: {
      id: string;
      name: string;
      label: string;
      type: string;
      required: boolean;
      maxLength?: number;
      options?: { id: number; label: string }[];
    }[] = [];

    for (const textarea of document.querySelectorAll("textarea")) {
      const label =
        textarea.getAttribute("aria-label") ||
        textarea.closest("label")?.textContent?.trim() ||
        "Message";
      fields.push({
        id: textarea.id || "message",
        name: textarea.getAttribute("name") || "message",
        label,
        type: "message",
        required: textarea.required,
        maxLength: textarea.maxLength > 0 ? textarea.maxLength : 500,
      });
    }

    for (const input of document.querySelectorAll("input[type='text'], input[type='url']")) {
      const label =
        input.getAttribute("aria-label") ||
        input.closest("label")?.textContent?.trim() ||
        input.getAttribute("placeholder") ||
        "Text";
      fields.push({
        id: input.id || label,
        name: input.getAttribute("name") || label,
        label,
        type: input.getAttribute("type") === "url" ? "url" : "text",
        required: (input as HTMLInputElement).required,
      });
    }

    for (const select of document.querySelectorAll("select")) {
      const label =
        select.getAttribute("aria-label") ||
        select.closest("label")?.textContent?.trim() ||
        "Choice";
      const options = [...select.querySelectorAll("option")]
        .filter((o) => o.value)
        .map((o, i) => ({
          id: Number(o.value) || i + 1,
          label: o.textContent?.trim() || "",
        }));
      fields.push({
        id: select.id || label,
        name: select.getAttribute("name") || label,
        label,
        type: "multiple_choice",
        required: (select as HTMLSelectElement).required,
        options,
      });
    }

    return fields as FormField[];
  });
}
