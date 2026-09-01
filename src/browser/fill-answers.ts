import type { Locator, Page } from "playwright";
import type { FormField } from "../questions.js";

export async function fillAnswers(
  page: Page,
  answers: Record<string, string | number>,
  fields: FormField[],
): Promise<void> {
  const dialog = page.getByRole("dialog");
  const scope: Page | Locator = (await dialog.count()) > 0 ? dialog : page;

  for (const field of fields) {
    const value = answers[field.name] ?? answers[field.id];
    if (value === undefined) continue;
    await fillField(scope, field, String(value));
  }

  if (answers.message) {
    const message = String(answers.message);
    const textarea = scope.locator("textarea").first();
    if ((await textarea.count()) > 0) {
      await textarea.fill(message);
    }
  }
}

async function fillField(scope: Page | Locator, field: FormField, text: string): Promise<void> {
  if (field.type === "message" || field.name === "message") {
    await scope.locator("textarea").first().fill(text);
    return;
  }

  const byLabel = scope
    .locator(`text=${escapeLabel(field.label)}`)
    .locator("..")
    .locator("textarea, input[type='url'], input[type='text']");
  if ((await byLabel.count()) > 0) {
    await byLabel.first().fill(text);
    return;
  }

  if (field.type === "url") {
    const input = scope.locator("input[type='url'], input[type='text']").first();
    if ((await input.count()) > 0) {
      await input.fill(text);
      return;
    }
    const textarea = scope.locator("textarea").nth(1);
    if ((await textarea.count()) > 0) {
      await textarea.fill(text);
    }
    return;
  }

  if (field.type === "long_text" || field.type === "text") {
    const textarea = scope.locator("textarea").first();
    if ((await textarea.count()) > 0) {
      await textarea.fill(text);
      return;
    }
    const input = scope.locator("input[type='text']").first();
    if ((await input.count()) > 0) await input.fill(text);
    return;
  }

  if (field.type === "multiple_choice") {
    const select = scope.locator("select").first();
    if ((await select.count()) > 0) {
      await select.selectOption({ label: text }).catch(async () => {
        await select.selectOption(text);
      });
    }
  }
}

function escapeLabel(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
