/**
 * Shared OIDC/MAS login building blocks — used by BOTH the CLI (device-code
 * grant) and the web UI (authorization-code + PKCE). Browser-safe (no
 * node:fs/path/v8/process/commander/fake-indexeddb): the functions here only
 * ever call browser-only matrix-js-sdk OIDC helpers (window.crypto for PKCE)
 * when actually invoked from the browser adapter — importing this module
 * under Node is safe (nothing here touches `window` at import time), calling
 * the PKCE-only functions from Node is not (by design: the CLI never calls
 * them, only the device-code functions, which are plain `fetch` calls).
 *
 * See docs/OAUTH_SPEC.md Part B and docs/DECISIONS.md D6.
 */
import { createClient } from "matrix-js-sdk";
import {
  registerOidcClient,
  generateScope,
  generateOidcAuthorizationUrl,
  completeAuthorizationCodeGrant,
  startDeviceAuthorization,
  waitForDeviceAuthorization,
  type OidcClientConfig,
  type OidcRegistrationClientMetadata,
  type DeviceAuthorizationResponse,
  type DeviceAccessTokenResponse,
  type DeviceAccessTokenError,
  type BearerTokenResponse,
} from "matrix-js-sdk/lib/oidc/index.js";
import type { AccessTokens, TokenRefreshFunction } from "matrix-js-sdk/lib/http-api/index.js";
import type { IdTokenClaims } from "oidc-client-ts";
import { CliError } from "./errors.js";

export type {
  OidcClientConfig,
  DeviceAuthorizationResponse,
  DeviceAccessTokenResponse,
  DeviceAccessTokenError,
  BearerTokenResponse,
  AccessTokens,
  TokenRefreshFunction,
};

/**
 * The full result of a completed OIDC login (device-code or authorization
 * code) — enough for a caller to build a ready `TeleCryptIOStorage` via
 * `TeleCryptIOStorage.createFromOidc(...)` AND to persist for reuse/refresh
 * across restarts (CLI: profile file; UI: localStorage).
 */
export interface OidcTokenSet {
  homeserverUrl: string;
  issuer: string;
  clientId: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  /** epoch ms, if the token response included an expiry. */
  expiresAt?: number;
}

/**
 * Discovers the OIDC/MAS issuer + endpoints for a homeserver, via
 * `MatrixClient.getAuthMetadata()` (MSC2965 `/auth_metadata`, falling back to
 * the legacy `/auth_issuer` + issuer well-known) — the non-deprecated path
 * recommended over `discoverAndValidateOIDCIssuerWellKnown`.
 *
 * NODE CALLERS: this internally constructs oidc-client-ts state that
 * requires `window.sessionStorage`/`window.localStorage` to exist (a real
 * browser has both natively). Under plain Node, wrap this ONE call in
 * `src/cli/oidcWindowPolyfill.ts`'s `withOidcWindowShim()` — see that file's
 * doc comment for why it must be scoped narrowly (a permanent global
 * `window` breaks the rust-crypto WASM's own environment detection) and why
 * it's safe here specifically (called once, before any crypto/WASM exists).
 */
export async function discoverOidcIssuer(homeserverBaseUrl: string): Promise<OidcClientConfig> {
  const client = createClient({ baseUrl: homeserverBaseUrl });
  try {
    return await client.getAuthMetadata();
  } catch (err) {
    throw new CliError(`OIDC discovery failed: ${(err as Error).message}`);
  }
}

/**
 * Dynamic client registration (DCR). `clientUri`/`redirectUris` must share a
 * host unless the issuer's policy allows a mismatch (our local dev/test MAS
 * does; production MAS may not — see docs/DECISIONS.md D6).
 */
export async function registerClient(
  authMetadata: OidcClientConfig,
  metadata: OidcRegistrationClientMetadata,
): Promise<string> {
  try {
    return await registerOidcClient(authMetadata, metadata);
  } catch (err) {
    throw new CliError(`OIDC dynamic client registration failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Device-code grant (RFC 8628) — the CLI's login flow. Plain `fetch` calls
// under the hood (matrix-js-sdk's `startDeviceAuthorization` /
// `waitForDeviceAuthorization`), nothing browser-only.
// ---------------------------------------------------------------------------

/**
 * Starts a device-code authorization session. `deviceId` is caller-chosen
 * (unlike the authorization-code flow, where the SDK picks a random one) so
 * it can be reused as this Matrix device's `device_id` throughout —
 * `generateScope(deviceId)` embeds it in the requested scope per MSC2967.
 */
export async function startDeviceCodeLogin(
  authMetadata: OidcClientConfig,
  clientId: string,
  deviceId: string,
): Promise<DeviceAuthorizationResponse> {
  const scope = generateScope(deviceId);
  return startDeviceAuthorization({ clientId, scope, metadata: authMetadata });
}

/**
 * Polls the token endpoint until the device-code session is approved (or
 * denied/expired) — see matrix-js-sdk's `waitForDeviceAuthorization` for the
 * RFC 8628 polling semantics (honours `interval`/`expires_in`,
 * `authorization_pending`/`slow_down`).
 */
export async function waitForDeviceCodeLogin(
  authMetadata: OidcClientConfig,
  clientId: string,
  session: DeviceAuthorizationResponse,
): Promise<DeviceAccessTokenResponse | DeviceAccessTokenError> {
  return waitForDeviceAuthorization({ session, metadata: authMetadata, clientId });
}

export function isDeviceAccessTokenError(
  result: DeviceAccessTokenResponse | DeviceAccessTokenError,
): result is DeviceAccessTokenError {
  return typeof (result as DeviceAccessTokenError).error === "string";
}

// ---------------------------------------------------------------------------
// Authorization code + PKCE — the web UI's login flow. Browser-only when
// actually called (uses window.crypto/window.sessionStorage internally via
// oidc-client-ts) — never called from the CLI.
// ---------------------------------------------------------------------------

/**
 * Builds the authorization URL to redirect the browser to. PKCE
 * verifier/state/nonce are generated and persisted to `window.sessionStorage`
 * internally by matrix-js-sdk/oidc-client-ts (`mx_oidc_`-prefixed keys) — the
 * caller does not need to manage them; `completeAuthorizationCodeFlow` reads
 * them back after the redirect.
 */
export async function beginAuthorizationCodeFlow(opts: {
  authMetadata: OidcClientConfig;
  clientId: string;
  homeserverUrl: string;
  redirectUri: string;
}): Promise<string> {
  const nonce = crypto.randomUUID();
  return generateOidcAuthorizationUrl({
    metadata: opts.authMetadata,
    clientId: opts.clientId,
    homeserverUrl: opts.homeserverUrl,
    redirectUri: opts.redirectUri,
    nonce,
  });
}

/** Completes the authorization-code exchange after the `?code&state` redirect. */
export async function completeAuthorizationCodeFlow(
  code: string,
  state: string,
): Promise<{
  tokenResponse: BearerTokenResponse;
  oidcClientSettings: { clientId: string; issuer: string };
  homeserverUrl: string;
  idTokenClaims: IdTokenClaims;
}> {
  return completeAuthorizationCodeGrant(code, state);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The device_id granted is embedded in the token response's `scope`
 * (`urn:matrix:org.matrix.msc2967.client:device:<id>`), per MSC2967 — the
 * authorization-code flow doesn't return it any other way (the SDK
 * auto-generates it when the caller doesn't request a specific one). */
export function extractDeviceIdFromScope(scope: string): string | null {
  const match = scope.match(/urn:matrix:org\.matrix\.msc2967\.client:device:(\S+)/);
  return match ? match[1] : null;
}

/** Confirms {userId, deviceId} for a freshly-obtained access token via
 * `GET /_matrix/client/v3/account/whoami` — needed because neither the
 * device-code nor authorization-code token response includes the Matrix
 * user ID. */
export async function whoAmI(
  homeserverUrl: string,
  accessToken: string,
): Promise<{ userId: string; deviceId: string | null }> {
  const client = createClient({ baseUrl: homeserverUrl, accessToken });
  const res = await client.whoami();
  return { userId: res.user_id, deviceId: res.device_id ?? null };
}

/**
 * Refreshes an access token via a plain RFC 6749 `grant_type=refresh_token`
 * POST to the token endpoint — deliberately NOT matrix-js-sdk's
 * `OidcTokenRefresher`/oidc-client-ts, which unconditionally construct an
 * internal `OidcClient` requiring `window.sessionStorage`/`window.
 * localStorage` even though a plain refresh never actually reads or writes
 * them (confirmed by direct testing: `ReferenceError: window is not
 * defined` under plain Node — see docs/DECISIONS.md D6 and
 * test/functional/oidc.test.ts O.2). A public client (`token_endpoint_auth_method:
 * "none"`, what `registerClient` above registers) authenticates a refresh
 * with just `client_id` in the body, no secret — this is the whole request.
 * Works identically in Node and the browser (plain `fetch`), so both
 * adapters share it with zero platform-specific code.
 */
export async function refreshOidcToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<AccessTokens> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new CliError(`OIDC token refresh failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiry: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
  };
}

/**
 * Builds the `tokenRefreshFunction` `TeleCryptIOStorage.createFromOidc`
 * expects: refreshes via `refreshOidcToken`, then calls `onPersist` with the
 * new tokens before returning them — so a caller's adapter-specific
 * persistence (CLI: profile file; UI: localStorage) always sees a refresh
 * that just happened, not just ones it initiated itself.
 */
export function buildTokenRefreshFunction(
  tokenEndpoint: string,
  clientId: string,
  onPersist: (tokens: { accessToken: string; refreshToken?: string }) => Promise<void>,
): TokenRefreshFunction {
  return async (refreshToken: string) => {
    const tokens = await refreshOidcToken(tokenEndpoint, clientId, refreshToken);
    await onPersist({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return tokens;
  };
}
