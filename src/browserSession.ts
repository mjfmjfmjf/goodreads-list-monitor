import chalk from 'chalk';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { chromium, BrowserContext } from 'playwright';
import { loadState } from './storage.js';

// Persistent, durable browser profile (NOT os.tmpdir() — macOS wipes /tmp on
// reboot, which would silently destroy a logged-in session).
export const BROWSER_PROFILE_DIR = path.join(os.homedir(), '.goodreads', 'browser-profile');

// The signed-in Goodreads header shows the account's own profile link
// "/user/show/<id>-<slug>" (e.g. /user/show/970632-mitchell-friedman).
const USER_SHOW_PATTERN = /href=["']\/user\/show\//i;

export function computeUserSlugId(): string | null {
  try {
    const userId = loadState()?.userId;
    if (userId) return `${userId}-`;
  } catch {
    // no userId configured — identity-specific login checking is unavailable
  }
  return null;
}

export function detectLoggedInMarkers(
  html: string,
  userIdPrefix: string | null
): { loggedIn: boolean; profileHref?: string } {
  if (userIdPrefix) {
    const re = new RegExp(`href=["']/user/show/${userIdPrefix}[^"'/]*["']`);
    const m = html.match(re);
    if (m) {
      return { loggedIn: true, profileHref: m[0].replace('href=', '').replace(/["']/g, '') };
    }
  }
  const anyProfile = html.match(/href=["']\/user\/show\/\d+-[^"'/]*["']/i);
  if (anyProfile) {
    return { loggedIn: true, profileHref: anyProfile[0].replace('href=', '').replace(/["']/g, '') };
  }
  return { loggedIn: false };
}

export async function launchBrowserProfile(): Promise<BrowserContext> {
  fs.ensureDirSync(path.dirname(BROWSER_PROFILE_DIR));
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, { headless: false });
}

// Load the hub page and check the header for signed-in markers. Returns
// undefined when the page couldn't be checked (network/throttle/parse).
export async function checkBrowserLogin(
  context: BrowserContext
): Promise<{ loggedIn: boolean; profileHref?: string; checked: boolean }> {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(30000);
    const resp = await page.goto('https://www.goodreads.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const html = await page.content();
    if (resp && resp.status() !== 200) {
      return { loggedIn: false, checked: false };
    }
    const result = detectLoggedInMarkers(html, computeUserSlugId());
    return { ...result, checked: true };
  } catch {
    return { loggedIn: false, checked: false };
  } finally {
    await page.close().catch(() => {});
  }
}

export interface BrowserLoginOptions {
  reset?: boolean;
  timeoutSeconds?: number;
}

// One-time interactive login: open a headed window, the user signs in by hand,
// the session is persisted to the durable profile for every --engine browser
// run afterwards. This is the ONLY reliable way to carry Amazon/Goodreads
// auth cookies (Secure/HttpOnly) into a real browser.
export async function runBrowserLogin(options: BrowserLoginOptions): Promise<void> {
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;
  if (options.reset) {
    console.log(chalk.yellow(`   Removing existing browser profile (${BROWSER_PROFILE_DIR})...`));
    await fs.remove(BROWSER_PROFILE_DIR);
  }

  console.log(chalk.cyan.bold('\n🧑‍🔬 One-time Goodreads login for the headed browser\n'));
  console.log(chalk.gray(`   Profile: ${BROWSER_PROFILE_DIR}`));

  const context = await launchBrowserProfile();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(30000);
    console.log(chalk.cyan('   Opening Goodreads in the window — SIGN IN now (email + password).'));
    console.log(chalk.gray(`   Watching for the signed-in profile link for up to ${timeoutMs / 1000}s. Ctrl-C to abort.`));
    await page.goto('https://www.goodreads.com/', { waitUntil: 'domcontentloaded' });

    const userIdPrefix = computeUserSlugId();
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    let lastMsg = '';
    while (Date.now() < deadline) {
      await page.waitForTimeout(4000);
      const html = await page.content().catch(() => '');
      const { loggedIn, profileHref } = detectLoggedInMarkers(html, userIdPrefix);
      if (loggedIn) {
        console.log(chalk.green(`\n   ✅ Signed in as ${profileHref ?? 'a Goodreads user'} — session saved to the profile.`));
        console.log(chalk.gray('   Future `--engine browser` runs will reuse it automatically.'));
        return;
      }
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const msg = `   ...waiting for you to sign in (${elapsed}s)...`;
      if (msg !== lastMsg) {
        console.log(chalk.gray(msg));
        lastMsg = msg;
      }
    }
    console.log(chalk.yellow('\n   Timed out waiting for login — session NOT saved.'));
    console.log(chalk.gray('   Re-run `npm run browser-login` when you are ready.'));
  } finally {
    await context.close().catch(() => {});
  }
}