import { withPublicBrowser } from "../session.js";
import { BASE_URL } from "../waas.js";
import { gotoAndReadInertia } from "./inertia.js";

export async function fetchPublicPageHtml(path: string): Promise<string> {
  return withPublicBrowser(async (page) => {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return page.content();
  });
}

export async function fetchPublicInertia(path: string) {
  return withPublicBrowser(async (page) => gotoAndReadInertia(page, `${BASE_URL}${path}`));
}
