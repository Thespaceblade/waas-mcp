import type { Page } from "playwright";

export type InertiaPage = {
  component?: string;
  props?: Record<string, unknown>;
  url?: string;
  version?: string;
};

export async function readInertiaFromPage(page: Page): Promise<InertiaPage | null> {
  return page.evaluate(() => {
    const el = document.querySelector("[data-page]");
    if (!el) return null;
    return JSON.parse(el.getAttribute("data-page") ?? "null");
  });
}

export async function gotoAndReadInertia(page: Page, url: string): Promise<InertiaPage | null> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector("[data-page]", { timeout: 15_000 }).catch(() => undefined);
  return readInertiaFromPage(page);
}
