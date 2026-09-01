import { parse } from "node-html-parser";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { COOKIE_PATH } from "./config.js";

export const BASE_URL = "https://www.workatastartup.com";
export const ACCOUNT_URL = "https://account.ycombinator.com";

/** YC account login used by WaaS nav (magic link / password). */
export function buildLoginUrl(continuePath = "/jobs"): string {
  const continueUrl = `${BASE_URL}${continuePath.startsWith("/") ? continuePath : `/${continuePath}`}`;
  return `${ACCOUNT_URL}/magic?continue=${encodeURIComponent(continueUrl)}`;
}

export type InertiaPage = {
  component?: string;
  props?: Record<string, unknown>;
  url?: string;
  version?: string;
};

export async function resolveSessionCookie(): Promise<string> {
  const fromEnv = process.env.WAAS_COOKIE?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(COOKIE_PATH)) {
    const fromFile = (await readFile(COOKIE_PATH, "utf8")).trim();
    if (fromFile) return fromFile;
  }

  throw new Error(
    "No Work at a Startup session found. Run `npm run login` or set WAAS_COOKIE — see README.",
  );
}

export async function fetchPage(path: string): Promise<{ response: Response; html: string; url: string }> {
  const sessionCookie = await resolveSessionCookie();
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: "follow",
    headers: {
      cookie: sessionCookie,
      "user-agent": "waas-mcp",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (bouncedToSignIn(response) || response.status === 401 || response.status === 403) {
    throw new Error(
      "workatastartup.com redirected to sign-in. Your session cookie probably expired — grab a fresh one from your browser.",
    );
  }

  return { response, html: await response.text(), url: response.url };
}

export async function postInertia(
  path: string,
  body: Record<string, unknown>,
  inertiaVersion: string,
): Promise<Response> {
  const sessionCookie = await resolveSessionCookie();
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: sessionCookie,
      "user-agent": "waas-mcp",
      accept: "text/html, application/xhtml+xml",
      "content-type": "application/json",
      "x-inertia": "true",
      "x-inertia-version": inertiaVersion,
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify(body),
  });
}

function bouncedToSignIn(response: Response): boolean {
  const { hostname, pathname } = new URL(response.url);
  if (hostname === "account.ycombinator.com") return true;
  return /\/(users\/)?sign_in/.test(pathname);
}

export function readInertiaPage(html: string): InertiaPage | null {
  const root = parse(html).querySelector("[data-page]");
  if (!root) return null;
  return JSON.parse(decodeHtmlEntities(root.getAttribute("data-page") ?? "")) as InertiaPage;
}

export function pick(source: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function skillNames(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((skill) => (typeof skill === "string" ? skill : (skill as { name?: string })?.name))
    .filter((name): name is string => Boolean(name));
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html: string): string {
  const withLineBreaks = (html ?? "")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  const text = parse(withLineBreaks).text;
  return decodeHtmlEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseJobId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/\/jobs\/(\d+)/);
  if (match?.[1]) return match[1];
  throw new Error(`Could not parse a job id from "${input}". Use a numeric id or /jobs/123 URL.`);
}

export function parseCompanySlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes("/")) return trimmed.replace(/^\/+/, "");
  const match = trimmed.match(/\/companies\/([^/?#]+)/);
  if (match?.[1]) return match[1];
  throw new Error(`Could not parse a company slug from "${input}". Use a slug or /companies/acme URL.`);
}
