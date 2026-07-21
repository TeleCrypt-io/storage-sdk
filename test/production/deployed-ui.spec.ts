// Deployed-UI smoke test — loads the LIVE https://storage.telecrypt.io in a
// real browser. Credential-free by design: proves the app mounts and that
// clicking "Log in with MAS/OIDC" reaches real MAS, then STOPS. Never enters
// credentials. See docs/PROD_TESTING_SPEC.md Part B.
//
// This is what catches the blank-page / "Multiple matrix-js-sdk
// entrypoints" regression class: a broken bundle can deploy successfully
// (the static files exist, the workflow goes green) while the app never
// actually renders in a browser — only a real page load against the real
// deployed URL catches that. Fully separate from ui/test/e2e/*, which
// drives the LOCAL dev server + disposable Synapse.
import { test, expect } from "@playwright/test";

const SITE_URL = "https://storage.telecrypt.io/";

test.describe("deployed UI smoke (storage.telecrypt.io)", () => {
  test("app mounts, no console errors on load, OIDC button reaches real MAS", async ({ page }) => {
    // Playwright's default browser context has no pre-existing cache/cookies
    // (a fresh context per test file by default), so this already tests the
    // live bundle rather than anything stale locally. What DOES lag is the
    // Pages CDN itself right after a deploy — poll until the origin is
    // actually serving before asserting on page content.
    await expect(async () => {
      const res = await page.request.get(SITE_URL);
      expect(res.ok()).toBe(true);
    }).toPass({ timeout: 60_000, intervals: [2000] });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(SITE_URL, { waitUntil: "networkidle" });

    // The mount check: a known element from the real login screen.
    const oidcButton = page.getByTestId("oidc-login");
    await expect(oidcButton).toBeVisible({ timeout: 15000 });

    // Asserted BEFORE clicking — the OIDC click triggers real discovery/DCR
    // network calls to prod MAS, which can legitimately log console noise
    // (matrix-js-sdk's own tracing) that has nothing to do with whether the
    // app mounted cleanly.
    expect(consoleErrors, `console errors on load:\n${consoleErrors.join("\n")}`).toEqual([]);

    await oidcButton.click();

    // Real dynamic client registration + PKCE authorization URL build,
    // then a same-tab redirect to production MAS's authorize/login page.
    await page.waitForURL(/^https:\/\/telecrypt\.io\/auth\//, { timeout: 20000 });
    expect(page.url()).toMatch(/^https:\/\/telecrypt\.io\/auth\//);

    // STOP HERE. Do not fill in or submit anything on MAS's real login form.
  });
});
