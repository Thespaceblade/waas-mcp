import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { COOKIE_PATH, ensureDataDir, LOGIN_SETUP_HINT, SESSION_PATH } from "./config.js";
import { BASE_URL, buildLoginUrl } from "./waas.js";

export async function runLoginFlow(): Promise<void> {
  ensureDataDir();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const loginUrl = buildLoginUrl("/jobs");
  console.log("\nOpening YC account login for Work at a Startup...");
  console.log(loginUrl);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  console.log("Sign in with your YC / Work at a Startup account in the browser window.");
  console.log("After login you should land on workatastartup.com (not account.ycombinator.com).");
  console.log("Press Enter here when you are logged in.\n");

  await waitForEnter();

  if (!page.url().startsWith(BASE_URL)) {
    await page.goto(`${BASE_URL}/jobs`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  const loggedIn = await isLoggedInPage(page);
  if (!loggedIn) {
    await browser.close();
    console.error(`Login not detected. ${LOGIN_SETUP_HINT}`);
    process.exit(1);
  }

  await context.storageState({ path: SESSION_PATH });
  const cookieHeader = await cookiesAsHeader(context);
  writeFileSync(COOKIE_PATH, cookieHeader, "utf8");

  await browser.close();
  console.log(`Session saved to ${SESSION_PATH}`);
  console.log(`Cookie header saved to ${COOKIE_PATH}\n`);
}

export async function checkSessionValid(): Promise<{ valid: boolean; message: string }> {
  if (!existsSync(SESSION_PATH) && !existsSync(COOKIE_PATH)) {
    return { valid: false, message: `No session saved. ${LOGIN_SETUP_HINT}` };
  }

  try {
    return await withBrowser(async (page) => {
      await page.goto(`${BASE_URL}/jobs`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const valid = await isLoggedInPage(page);
      return valid
        ? { valid: true, message: "Session is active" }
        : { valid: false, message: `Session expired. ${LOGIN_SETUP_HINT}` };
    });
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function withBrowser<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  options?: { headless?: boolean; persistSession?: boolean },
): Promise<T> {
  if (!existsSync(SESSION_PATH) && !existsSync(COOKIE_PATH)) {
    throw new Error(`No session saved. ${LOGIN_SETUP_HINT}`);
  }

  const browser = await chromium.launch({ headless: options?.headless ?? true });
  const context = await browser.newContext({
    ...(existsSync(SESSION_PATH) ? { storageState: SESSION_PATH } : {}),
    viewport: { width: 1400, height: 900 },
  });

  if (!existsSync(SESSION_PATH) && existsSync(COOKIE_PATH)) {
    const cookieHeader = readFileSync(COOKIE_PATH, "utf8").trim();
    const cookies = cookieHeader.split(";").map((part) => {
      const [name, ...rest] = part.trim().split("=");
      return { name, value: rest.join("="), domain: ".workatastartup.com", path: "/" };
    });
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    if (options?.persistSession) {
      await context.storageState({ path: SESSION_PATH });
      writeFileSync(COOKIE_PATH, await cookiesAsHeader(context), "utf8");
    }
    await browser.close();
  }
}

export async function withPublicBrowser<T>(
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function cookiesAsHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(BASE_URL);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export async function isLoggedInPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("account.ycombinator.com")) return false;

  const fromInertia = await page.evaluate(() => {
    const el = document.querySelector("[data-page]");
    if (!el) return null;
    try {
      const data = JSON.parse(el.getAttribute("data-page") ?? "") as {
        props?: {
          rails_context?: { currentUser?: unknown };
          nav?: { paths?: { logout?: string | null; login?: string | null } };
        };
      };
      const currentUser = data.props?.rails_context?.currentUser;
      if (currentUser != null) return true;
      if (data.props?.nav?.paths?.logout) return true;
      if (data.props?.nav?.paths?.login == null) return true;
      return false;
    } catch {
      return null;
    }
  });
  if (fromInertia === true) return true;
  if (fromInertia === false) return false;

  if ((await page.getByRole("link", { name: /my profile/i }).count()) > 0) return true;
  if ((await page.getByRole("link", { name: /log out|sign out/i }).count()) > 0) return true;

  return false;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}
