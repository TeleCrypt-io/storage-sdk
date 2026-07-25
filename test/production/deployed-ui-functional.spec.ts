// Deployed-UI functional test — loads LIVE https://storage.telecrypt.io,
// completes real OIDC login with operator-verified test credentials, waits
// for connect (NOT stuck on "Connecting…"), then exercises the file manager.
// See docs/PROD_TESTING_SPEC.md Part C.
//
// Requires PROD_TEST_USER_1 / PROD_TEST_PASS_1 (repo secrets in CI).
// Deliberately separate from deployed-ui.spec.ts (Part B smoke), which stays
// credential-free.
import { test, expect } from "@playwright/test";
import {
  requireProdCredentials,
  loginViaProdOidc,
  expectLoggedInFileManager,
  createFolder,
  uploadFile,
  downloadFileBytes,
  deleteFolderViaUI,
} from "./prodUiHelpers";

test.describe("deployed UI functional (storage.telecrypt.io)", () => {
  test("OIDC login connects and folder upload/download round-trips", async ({ page }) => {
    const creds = requireProdCredentials();
    const folderName = `prod-ui-${Date.now()}`;
    const fileName = "prod-functional.txt";
    const payload = Buffer.from(`prod ui functional ${Date.now()}\n`.repeat(20));

    await loginViaProdOidc(page, creds);
    await expectLoggedInFileManager(page, creds.userId);

    await createFolder(page, folderName);
    await uploadFile(page, fileName, "text/plain", payload);

    const downloaded = await downloadFileBytes(page, fileName);
    expect(downloaded.equals(payload)).toBe(true);

    await deleteFolderViaUI(page, folderName);
  });
});
