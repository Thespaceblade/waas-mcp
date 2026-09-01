import type { Page } from "playwright";
import { detectApplyLimitMessage } from "../quota.js";

export type ApplyUiState = {
  canOpenApply: boolean;
  canSend: boolean;
  limitMessage: string | null;
  modalText: string | null;
};

export async function readApplyUiState(page: Page): Promise<ApplyUiState> {
  const applyCount = await page.getByRole("link", { name: /^Apply$/ }).count();
  const appliedCount = await page.getByRole("link", { name: /^Applied$/ }).count();
  const canOpenApply = applyCount > 0 && appliedCount === 0;

  if (!canOpenApply) {
    return {
      canOpenApply,
      canSend: false,
      limitMessage: null,
      modalText: null,
    };
  }

  await page.getByRole("link", { name: /^Apply$/ }).first().click({ force: true });
  await page.waitForTimeout(1500);

  const modalText = await page.evaluate(() => {
    const body = document.body.innerText ?? "";
    const start = body.indexOf("Reach out to");
    if (start === -1) return body.slice(0, 1200);
    return body.slice(start, start + 1200);
  });

  const canSend = (await page.getByRole("button", { name: /^Send$/ }).count()) > 0;
  const limitMessage = detectApplyLimitMessage(modalText);

  if (!canSend && !limitMessage && /limit|per week|this week/i.test(modalText)) {
    return {
      canOpenApply,
      canSend,
      limitMessage: modalText.split("\n").find((line) => /limit|week/i.test(line)) ?? modalText.slice(0, 300),
      modalText,
    };
  }

  return {
    canOpenApply,
    canSend,
    limitMessage,
    modalText,
  };
}
