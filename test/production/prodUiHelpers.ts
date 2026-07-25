// Shared helpers for deployed-UI Playwright tests against live
// https://storage.telecrypt.io. See docs/PROD_TESTING_SPEC.md Part C.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const PROD_HOMESERVER = "https://telecrypt.io";
const SITE_URL = "https://storage.telecrypt.io/";

export interface ProdCredentials {
  username: string;
  password: string;
  userId: string;
}

/** Fail loudly when CI/local forgot to wire the verified test-account secrets. */
export function requireProdCredentials(): ProdCredentials {
  const username = process.env.PROD_TEST_USER_1;
  const password = process.env.PROD_TEST_PASS_1;
  if (!username || !password) {
    throw new Error(
      "PROD_TEST_USER_1 and PROD_TEST_PASS_1 are required for deployed-UI functional tests",
    );
  }
  const localpart = username.startsWith("@") ? username.slice(1).split(":")[0]! : username;
  const userId = username.startsWith("@") ? username : `@${username}:${new URL(PROD_HOMESERVER).host}`;
  return { username: localpart, password, userId };
}

export async function clearBrowserStorage(page: Page): Promise<void> {
  await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/** Poll until the live Pages origin serves before driving login. */
export async function waitForDeployedSite(page: Page): Promise<void> {
  await expect(async () => {
    const res = await page.request.get(SITE_URL);
    expect(res.ok()).toBe(true);
  }).toPass({ timeout: 60_000, intervals: [2000] });
}

/** Full OIDC round-trip through production MAS (telecrypt.io/auth/). */
export async function loginViaProdOidc(page: Page, creds: ProdCredentials): Promise<void> {
  await waitForDeployedSite(page);
  await clearBrowserStorage(page);

  await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });
  await page.getByTestId("oidc-login").click();

  await page.waitForURL(/^https:\/\/telecrypt\.io\/auth\//, { timeout: 30_000 });
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Continue" }).click();

  const consentCheckbox = page.locator('input[type="checkbox"]');
  if (await consentCheckbox.isVisible({ timeout: 5000 }).catch(() => false)) {
    await consentCheckbox.check();
  }
  const continueBtn = page.getByRole("button", { name: "Continue" });
  if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await continueBtn.click();
  }

  await page.waitForURL(/^https:\/\/storage\.telecrypt\.io\//, { timeout: 30_000 });
}

/** Wait until connect completes — not stuck on Connecting. First login can
 * take up to ~90s while WASM + IndexedDB initialize on GitHub Pages. */
export async function expectLoggedInFileManager(page: Page, userId: string): Promise<void> {
  await expect(page.getByTestId("current-user")).toHaveText(userId, { timeout: 120_000 });
  await expect(page.getByTestId("file-manager")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("connecting")).not.toBeVisible();
}

export async function createFolder(page: Page, name: string): Promise<string> {
  await page.getByTestId("new-folder-name").fill(name);
  await page.getByTestId("create-folder").click();
  const item = page.locator('[data-testid="folder-item"]', { hasText: name });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("folder-detail")).toBeVisible({ timeout: 15_000 });
  const folderId = await item.getAttribute("data-folder-id");
  if (!folderId) throw new Error(`folder item for "${name}" has no data-folder-id`);
  return folderId;
}

export async function uploadFile(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<void> {
  await page.getByTestId("file-input").setInputFiles({ name, mimeType, buffer });
  await expect(page.locator('[data-testid="file-item"]', { hasText: name })).toBeVisible({
    timeout: 60_000,
  });
}

export async function downloadFileBytes(page: Page, name: string): Promise<Buffer> {
  const row = page.locator('[data-testid="file-item"]', { hasText: name });
  const button = row.getByTestId("download-file");

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 5000 }),
        button.click(),
      ]);
      const stream = await download.createReadStream();
      if (!stream) throw new Error("download had no stream");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await page.waitForTimeout(500);
    }
  }
}

/** Best-effort delete of a folder created during the test. */
export async function deleteFolderViaUI(page: Page, folderName: string): Promise<void> {
  try {
    const btn = page.locator(".folder-list-btn", { hasText: folderName });
    if (!(await btn.isVisible({ timeout: 3000 }).catch(() => false))) return;
    await btn.click();
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("delete-folder").click();
    await expect(page.locator('[data-testid="folder-item"]', { hasText: folderName })).not.toBeVisible({
      timeout: 30_000,
    });
  } catch {
    // best-effort cleanup
  }
}
