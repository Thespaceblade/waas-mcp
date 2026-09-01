import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = join(homedir(), ".waas-mcp");
export const SESSION_PATH = join(DATA_DIR, "storage-state.json");
export const COOKIE_PATH = join(DATA_DIR, "cookie.txt");
export const APPLIED_PATH = join(DATA_DIR, "applied.json");
export const PROFILE_PATH = join(DATA_DIR, "profile.json");

export const LOGIN_SETUP_HINT =
  "Run `npm run login` in the waas-mcp project, sign in with your YC / Work at a Startup account, then press Enter.";

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function hasSession(): boolean {
  return existsSync(SESSION_PATH) || existsSync(COOKIE_PATH);
}
