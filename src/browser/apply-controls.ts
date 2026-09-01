import type { Locator, Page } from "playwright";

/** WaaS renders Apply as a styled <a> without href — not exposed as role=link. */
export function applyControl(page: Page | Locator): Locator {
  return page.locator("a, button").filter({ hasText: /^Apply$/ });
}

export function appliedControl(page: Page | Locator): Locator {
  return page.locator("a, button").filter({ hasText: /^Applied$/ });
}

export async function readApplyAnchor(page: Page): Promise<{ applied: boolean; canApply: boolean }> {
  if ((await appliedControl(page).count()) > 0) {
    return { applied: true, canApply: false };
  }
  if ((await applyControl(page).count()) > 0) {
    return { applied: false, canApply: true };
  }
  return { applied: false, canApply: false };
}

export async function openApplyModal(page: Page): Promise<void> {
  const apply = applyControl(page).first();
  if ((await apply.count()) === 0) {
    throw new Error("Could not find Apply button on job page.");
  }
  await apply.click();
  await page.waitForTimeout(1000);
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
}
