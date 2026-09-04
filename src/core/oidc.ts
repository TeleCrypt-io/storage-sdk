/**
 * Shared OIDC/MAS login building blocks — used by BOTH the CLI (device-code
 * grant) and the web UI (authorization-code + PKCE). Browser-safe (no
 * node:fs/path/v8/process/commander/fake-indexeddb): browser state is only
 * touched when the PKCE functions are called by the web adapter. Importing
 * this module under Node is safe; the CLI uses the device-code functions,
 * which are plain fetch calls.
 */
import { createClient } from "matrix-js-sdk";
import {
  generateScope,
  type DeviceAuthorizationResponse,
  type DeviceAccessTokenResponse,
  type DeviceAccessTokenError,
  type BearerTokenResponse as OAuthBearerTokenResponse,
  type OAuthRegistrationRequest,
  type ValidatedAuthMetadata,
  isValidDeviceAccessTokenResponse,
  normalizeBearerTokenResponseTokenType,
  validateBearerTokenResponse,
  validateDeviceAuthorizationResponse,
  validateRegistrationResponse,
  OAuthGrantType,
  OAuth2,
} from "matrix-js-sdk/lib/oauth/index.js";
import type { AccessTokens, TokenRefreshFunction } from "matrix-js-sdk/lib/http-api/index.js";
import { StorageError } from "./errors.js";
import { raceWithAbort, readBoundedResponseBody } from "./http.js";
import {
  validateCanonicalMatrixUserId,
  validateMatrixDeviceId,
} from "./constants.js";

/** Matrix 1.18 OAuth metadata returned by `/auth_metadata`. */
// Matrix SDK 42's metadata type/guard still treats revocation as required,
// but Matrix auth metadata makes it optional. Login and discovery only need
// the issuer, authorization, registration, and token endpoints; revocation is
// used opportunistically by the refresh persistence failure path below.
export type OidcClientConfig = Omit<ValidatedAuthMetadata, "revocation_endpoint"> & {
  revocation_endpoint?: string;
};

export type { DeviceAuthorizationResponse, DeviceAccessTokenResponse, DeviceAccessTokenError, AccessTokens, TokenRefreshFunction };

/** The bearer response retained by the browser authorization-code API. */
export type BearerTokenResponse = OAuthBearerTokenResponse & { scope: string };

/** The camel-case registration contract used by TeleCrypt web and CLI callers. */
export interface OidcRegistrationClientMetadata {
  clientName?: string;
  clientUri: string;
  logoUri?: string;
  applicationType?: "web" | "native";
  redirectUris?: [string, ...string[]];
  contacts?: string[];
  tosUri?: string;
  policyUri?: string;
}

/** The issuer-bound endpoints accepted by the token refresh adapter. */
export type OidcTokenEndpointMetadata = Pick<
  OidcClientConfig,
  "issuer" | "token_endpoint" | "revocation_endpoint"
>;

const AUTHORIZATION_CONTEXT_PREFIX = "telecrypt:oauth2:pkce:v1:";
const AUTHORIZATION_CONTEXT_VERSION = 1;
// The callback context is a short-lived transaction, not a durable login
// session. Ten minutes covers normal redirects while limiting replay after a
// stale browser tab or session-storage copy is recovered.
const AUTHORIZATION_CONTEXT_MAX_AGE_MS = 10 * 60 * 1000;
const AUTHORIZATION_CONTEXT_MAX_FUTURE_SKEW_MS = 30 * 1000;
const MAX_AUTHORIZATION_CONTEXT_LENGTH = 64 * 1024;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const STATE_PATTERN = /^[A-Za-z0-9._~-]{32,128}$/;
const MAX_OAUTH_ERROR_BODY_BYTES = 16 * 1024;
const MAX_OAUTH_SUCCESS_BODY_BYTES = 32 * 1024;
const OIDC_REQUEST_TIMEOUT_MS = 30_000;
const OIDC_REFRESH_TIMEOUT_MS = 30_000;
const OIDC_CLEANUP_TIMEOUT_MS = 30_000;
const MAX_OIDC_URL_LENGTH = 2048;
const MAX_OIDC_METADATA_STRING_LENGTH = 4096;
const MAX_OIDC_CLIENT_ID_LENGTH = 512;
const MAX_OIDC_CODE_LENGTH = 4096;
const MAX_OIDC_TOKEN_LENGTH = 8192;
const MAX_OIDC_SCOPE_LENGTH = 4096;
const MAX_OIDC_CONTACTS = 16;
const MAX_OIDC_REDIRECT_URIS = 8;
const LEGACY_MATRIX_SCOPE_PREFIX = "urn:matrix:client:";
const MSC2967_MATRIX_SCOPE_PREFIX = "urn:matrix:org.matrix.msc2967.client:";
const MATRIX_SCOPE_PREFIXES = [LEGACY_MATRIX_SCOPE_PREFIX, MSC2967_MATRIX_SCOPE_PREFIX] as const;
// MAS advertises a 20-minute device-code lifetime. Keep that provider window
// as the hard upper bound while retaining a finite polling budget.
const MAX_DEVICE_EXPIRES_IN_SECONDS = 20 * 60;
const MAX_DEVICE_INTERVAL_SECONDS = 5 * 60;
const MAX_DEVICE_POLL_DURATION_MS = MAX_DEVICE_EXPIRES_IN_SECONDS * 1000;
const deviceAuthorizationDeviceIds = new WeakMap<object, string>();
const SAFE_OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_token",
  "temporarily_unavailable",
  "server_error",
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "expired",
]);

interface BoundedResponseText {
  text: string;
  truncated: boolean;
}

interface SafeOAuthError {
  code: string;
}

class OidcRequestTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`OIDC ${operation} timed out`);
    this.name = "OidcRequestTimeoutError";
  }
}

class OidcRequestCancelledError extends Error {
  constructor(readonly operation: string) {
    super(`OIDC ${operation} cancelled`);
    this.name = "OidcRequestCancelledError";
  }
}

/** A local response-consistency failure that must remain distinguishable from
 * a sanitized provider/transport failure. The message is fixed and contains
 * no provider-controlled data. */
class OidcValidationError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "OidcValidationError";
  }
}

interface AuthorizationCodeContext {
  version: typeof AUTHORIZATION_CONTEXT_VERSION;
  createdAtMs: number;
  state: string;
  authMetadata: OidcClientConfig;
  clientId: string;
  redirectUri: string;
  homeserverUrl: string;
  deviceId: string;
  codeVerifier: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function requireString(value: unknown, name: string, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OIDC_METADATA_STRING_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  return value;
}

function requireClientId(value: unknown): string {
  const clientId = requireString(value, "client ID");
  if (clientId.length > MAX_OIDC_CLIENT_ID_LENGTH || /\s/.test(clientId)) {
    throw new StorageError("OIDC authorization context has an invalid client ID");
  }
  return clientId;
}

function requireBoundedString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  return value;
}

function requireScope(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OIDC_SCOPE_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.trim() !== value ||
    /\s{2,}/.test(value)
  ) {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseSafeRedirectUri(value: unknown, name: string): URL {
  const text = requireBoundedString(value, name, MAX_OIDC_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  const isRootWithoutSlash = parsed.pathname === "/" && parsed.toString() === `${text}/`;
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (parsed.toString() !== text && !isRootWithoutSlash)
  ) {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  return parsed;
}

function requireMetadataString(value: unknown, name: string, maxLength = MAX_OIDC_METADATA_STRING_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new StorageError(`OIDC dynamic client registration has an invalid ${name}`);
  }
  return value;
}

function validateRegistrationMetadata(metadata: OidcRegistrationClientMetadata): {
  clientUri: URL;
  redirectUris?: [string, ...string[]];
} {
  const clientUri = parseHttpUrl(metadata.clientUri, "client URI");
  if (metadata.clientName !== undefined) requireMetadataString(metadata.clientName, "client name");
  for (const [name, value] of [
    ["logo URI", metadata.logoUri],
    ["terms URI", metadata.tosUri],
    ["policy URI", metadata.policyUri],
  ] as const) {
    if (value !== undefined) {
      const uri = parseHttpUrl(value, name);
      if (uri.origin !== clientUri.origin) {
        throw new StorageError("OIDC dynamic client registration has an untrusted metadata origin");
      }
    }
  }
  if (metadata.contacts !== undefined) {
    if (!Array.isArray(metadata.contacts) || metadata.contacts.length > MAX_OIDC_CONTACTS) {
      throw new StorageError("OIDC dynamic client registration has too many contacts");
    }
    metadata.contacts.forEach((contact) => requireMetadataString(contact, "contact", 512));
  }
  if (metadata.redirectUris === undefined) return { clientUri };
  if (
    !Array.isArray(metadata.redirectUris) ||
    metadata.redirectUris.length === 0 ||
    metadata.redirectUris.length > MAX_OIDC_REDIRECT_URIS
  ) {
    throw new StorageError("OIDC dynamic client registration has too many redirect URIs");
  }
  const redirectUris = metadata.redirectUris.map((value) => {
    const uri = parseSafeRedirectUri(value, "redirect URI");
    if (uri.origin !== clientUri.origin) {
      throw new StorageError("OIDC dynamic client registration has an untrusted redirect origin");
    }
    return uri.toString();
  }) as [string, ...string[]];
  return { clientUri, redirectUris };
}

async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_OAUTH_ERROR_BODY_BYTES,
  signal?: AbortSignal,
): Promise<BoundedResponseText> {
  const body = await readBoundedResponseBody(response, maxBytes, signal);
  return { text: new TextDecoder().decode(body.bytes), truncated: body.truncated };
}

async function readBoundedJsonResponse(
  response: Response,
  operation: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const maxBytes = response.ok ? MAX_OAUTH_SUCCESS_BODY_BYTES : MAX_OAUTH_ERROR_BODY_BYTES;
  const body = await readBoundedResponseText(response, maxBytes, signal);
  if (body.truncated) {
    throw new StorageError(`OIDC ${operation} returned an oversized response`);
  }
  try {
    return JSON.parse(body.text);
  } catch {
    throw new StorageError(`OIDC ${operation} returned an invalid response`);
  }
}

function assertNoRedirect(response: Response, endpoint: string, operation: string): void {
  // OAuth request bodies contain bearer credentials, refresh tokens, or
  // authorization codes. Redirects must never be followed with those bodies.
  // `redirect: "manual"` makes this a local rejection rather than a network
  // hop, and the URL check protects callers that provide a non-canonical URL.
  if (
    (response.status >= 300 && response.status < 400) ||
    response.type === "opaqueredirect" ||
    (response.url !== "" && response.url !== endpoint) ||
    response.redirected
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new StorageError(`OIDC ${operation} rejected an untrusted redirect`);
  }
}

function exactEndpoint(value: string, name: string): string {
  return parseHttpUrl(value, name).toString();
}

function parseSafeOAuthError(body: string): SafeOAuthError | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.error !== "string" || !SAFE_OAUTH_ERROR_CODES.has(parsed.error)) {
    return undefined;
  }
  return { code: parsed.error };
}

function formatTokenRefreshFailure(status: number, body: BoundedResponseText): string {
  if (body.truncated) {
    return `OIDC token refresh failed (${status}): provider error response was too large`;
  }
  const oauthError = parseSafeOAuthError(body.text);
  if (!oauthError) {
    return `OIDC token refresh failed (${status}): provider returned an invalid OAuth error response`;
  }
  return `OIDC token refresh failed (${status}): OAuth error ${oauthError.code}`;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.httpStatus !== "number") return undefined;
  return Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
    ? error.httpStatus
    : undefined;
}

function formatProviderFailure(operation: string, error: unknown): string {
  if (error instanceof OidcRequestTimeoutError) return error.message;
  if (error instanceof OidcRequestCancelledError) return error.message;
  const status = providerErrorStatus(error);
  return `OIDC ${operation} failed${status === undefined ? "" : ` (${status})`}`;
}

function ensureOidcNotCancelled(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new OidcRequestCancelledError(operation);
}

async function requestWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  operation: string,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  timeoutMs = OIDC_REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  const signals = [externalSignal, init.signal].filter((signal): signal is AbortSignal => signal != null);
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  try {
    const response = await raceWithAbort(
      fetch(input, { ...init, signal: controller.signal }),
      controller.signal,
      () => undefined,
      () =>
        timedOut
          ? new OidcRequestTimeoutError(operation)
          : new OidcRequestCancelledError(operation),
    );
    return await consume(response, controller.signal);
  } catch (error) {
    if (timedOut) throw new OidcRequestTimeoutError(operation);
    if (signals.some((signal) => signal.aborted)) {
      throw new OidcRequestCancelledError(operation);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    for (const signal of signals) signal.removeEventListener("abort", abort);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new OidcRequestCancelledError("device authorization"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new OidcRequestCancelledError("device authorization"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input).toString();
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * MatrixClient's OAuth helpers use the SDK HTTP layer for discovery and
 * whoami. Supply a bounded/manual-redirect fetch implementation so those
 * calls have the same body and credential boundary as the direct OAuth calls.
 */
function boundedMatrixFetch(operation: string, externalSignal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const endpoint = requestUrl(input);
    return requestWithTimeout(
      input,
      { ...init, redirect: "manual" },
      operation,
      async (response, requestSignal) => {
        assertNoRedirect(response, endpoint, operation);
        const maxBytes = response.ok ? MAX_OAUTH_SUCCESS_BODY_BYTES : MAX_OAUTH_ERROR_BODY_BYTES;
        const body = await readBoundedResponseText(response, maxBytes, requestSignal);
        if (body.truncated) {
          if (response.ok) {
            throw new StorageError(`OIDC ${operation} returned an oversized response`);
          }
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
          });
        }
        return new Response(body.text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      OIDC_REQUEST_TIMEOUT_MS,
      externalSignal,
    );
  };
}

function parseHttpUrl(value: unknown, name: string): URL {
  const text = requireBoundedString(value, name, MAX_OIDC_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  const isRootWithoutSlash = parsed.pathname === "/" && parsed.toString() === `${text}/`;
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.toString() !== text && !isRootWithoutSlash)
  ) {
    throw new StorageError(`OIDC authorization context has an invalid ${name}`);
  }
  return parsed;
}

function isWithinIssuerPath(issuer: URL, endpoint: URL): boolean {
  if (issuer.pathname === "/") return true;
  const prefix = issuer.pathname.endsWith("/") ? issuer.pathname : `${issuer.pathname}/`;
  return endpoint.pathname === issuer.pathname || endpoint.pathname.startsWith(prefix);
}

function matrixAuthMetadataEndpoint(homeserver: URL): string {
  const basePath = homeserver.pathname.replace(/\/+$/u, "");
  return new URL(`${basePath}/_matrix/client/v1/auth_metadata`, homeserver.origin).toString();
}

function validateTokenEndpointMetadata(metadata: OidcTokenEndpointMetadata): {
  tokenEndpoint: string;
  revocationEndpoint?: string;
} {
  const issuer = parseHttpUrl(metadata.issuer, "issuer");
  const tokenEndpoint = parseHttpUrl(metadata.token_endpoint, "token endpoint");
  if (tokenEndpoint.origin !== issuer.origin || !isWithinIssuerPath(issuer, tokenEndpoint)) {
    throw new StorageError("OIDC token endpoint is outside the validated issuer");
  }
  let revocationEndpoint: string | undefined;
  if (metadata.revocation_endpoint !== undefined) {
    const parsed = parseHttpUrl(metadata.revocation_endpoint, "revocation endpoint");
    if (parsed.origin !== issuer.origin || !isWithinIssuerPath(issuer, parsed)) {
      throw new StorageError("OIDC revocation endpoint is outside the validated issuer");
    }
    revocationEndpoint = parsed.toString();
  }
  return { tokenEndpoint: tokenEndpoint.toString(), revocationEndpoint };
}

function validateAuthMetadata(value: unknown): OidcClientConfig {
  if (!isRecord(value)) {
    throw new StorageError("OIDC authorization context has invalid auth metadata");
  }
  const metadata = value as unknown as Record<string, unknown>;
  // Validate the stable Matrix auth-metadata contract locally. The Matrix SDK
  // guard currently models revocation_endpoint as required even though the
  // protocol makes it optional; substituting a fake endpoint there would turn
  // malformed metadata into a trusted credential destination.
  for (const name of [
    "issuer",
    "authorization_endpoint",
    "registration_endpoint",
    "token_endpoint",
  ]) {
    const field = metadata[name];
    if (
      field !== undefined &&
      (typeof field !== "string" ||
        field.length === 0 ||
        field.length > MAX_OIDC_URL_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(field))
    ) {
      throw new StorageError("OIDC authorization context has invalid auth metadata");
    }
  }
  for (const name of ["issuer", "authorization_endpoint", "registration_endpoint", "token_endpoint"]) {
    if (metadata[name] === undefined) {
      throw new StorageError("OIDC authorization context has invalid auth metadata");
    }
  }
  for (const name of [
    "revocation_endpoint",
    "device_authorization_endpoint",
    "account_management_uri",
  ]) {
    const field = metadata[name];
    if (
      field !== undefined &&
      (typeof field !== "string" ||
        field.length === 0 ||
        field.length > MAX_OIDC_URL_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(field))
    ) {
      throw new StorageError("OIDC authorization context has invalid auth metadata");
    }
  }
  for (const name of [
    "response_modes_supported",
    "response_types_supported",
    "grant_types_supported",
    "code_challenge_methods_supported",
    "prompt_values_supported",
    "account_management_actions_supported",
  ]) {
    const field = metadata[name];
    if (
      field !== undefined &&
      (!Array.isArray(field) || field.length > 32 || field.some(
        (item) =>
          typeof item !== "string" ||
          item.length === 0 ||
          item.length > MAX_OIDC_METADATA_STRING_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(item),
      ))
    ) {
      throw new StorageError("OIDC authorization context has invalid auth metadata");
    }
  }
  for (const name of ["response_types_supported", "grant_types_supported", "code_challenge_methods_supported"]) {
    if (!Array.isArray(metadata[name]) || (metadata[name] as unknown[]).length === 0) {
      throw new StorageError("OIDC authorization context has invalid auth metadata");
    }
  }
  return value as unknown as OidcClientConfig;
}

/** TeleCrypt's extra trust boundary for browser state rehydration. */
function validateTrustedAuthMetadata(value: unknown): OidcClientConfig {
  const metadata = validateAuthMetadata(value);
  const issuer = parseHttpUrl(metadata.issuer, "issuer");
  const endpoints: Array<[string, unknown]> = [
    ["authorization endpoint", metadata.authorization_endpoint],
    ["registration endpoint", metadata.registration_endpoint],
    ["token endpoint", metadata.token_endpoint],
  ];
  if (metadata.revocation_endpoint !== undefined) {
    endpoints.push(["revocation endpoint", metadata.revocation_endpoint]);
  }
  if (metadata.device_authorization_endpoint !== undefined) {
    endpoints.push(["device authorization endpoint", metadata.device_authorization_endpoint]);
  }
  for (const [name, value] of endpoints) {
    const endpoint = parseHttpUrl(value, name);
    if (endpoint.origin !== issuer.origin || !isWithinIssuerPath(issuer, endpoint)) {
      throw new StorageError(`OIDC authorization context has an invalid ${name}`);
    }
  }
  return metadata;
}

function validateDeviceAuthorizationSession(value: unknown): DeviceAuthorizationResponse {
  try {
    validateDeviceAuthorizationResponse(value);
  } catch {
    throw new StorageError("OIDC device authorization returned an invalid response");
  }
  const session = value as DeviceAuthorizationResponse;
  requireBoundedString(session.device_code, "device code", MAX_OIDC_CODE_LENGTH);
  requireBoundedString(session.user_code, "user code", MAX_OIDC_CODE_LENGTH);
  parseSafeRedirectUri(session.verification_uri, "verification URI");
  if (session.verification_uri_complete !== undefined) {
    parseSafeRedirectUri(session.verification_uri_complete, "complete verification URI");
  }
  if (
    !Number.isInteger(session.expires_in) ||
    session.expires_in <= 0 ||
    session.expires_in > MAX_DEVICE_EXPIRES_IN_SECONDS
  ) {
    throw new StorageError("OIDC device authorization returned an invalid expiry");
  }
  if (
    session.interval !== undefined &&
    (!Number.isInteger(session.interval) ||
      session.interval <= 0 ||
      session.interval > MAX_DEVICE_INTERVAL_SECONDS)
  ) {
    throw new StorageError("OIDC device authorization returned an invalid polling interval");
  }
  return session;
}

function validateDeviceAccessTokenResponse(value: unknown): DeviceAccessTokenResponse {
  if (!isValidDeviceAccessTokenResponse(value)) {
    throw new StorageError("OIDC device authorization returned an invalid token response");
  }
  const response = value as DeviceAccessTokenResponse;
  if (response.token_type.toLowerCase() !== "bearer") {
    throw new StorageError("OIDC device authorization returned an invalid token type");
  }
  validateTokenBounds(response, "device authorization");
  return response;
}

function validateTokenBounds(value: {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}, operation: string): void {
  try {
    requireBoundedString(value.access_token, "access token", MAX_OIDC_TOKEN_LENGTH);
    if (value.refresh_token !== undefined) {
      requireBoundedString(value.refresh_token, "refresh token", MAX_OIDC_TOKEN_LENGTH);
    }
    if (value.scope !== undefined) requireScope(value.scope, "scope");
  } catch {
    throw new StorageError(`OIDC ${operation} returned an invalid token response`);
  }
  if (
    value.expires_in !== undefined &&
    (!Number.isInteger(value.expires_in) || value.expires_in < 0 || value.expires_in > 86400)
  ) {
    throw new StorageError(`OIDC ${operation} returned an invalid token expiry`);
  }
}

function sessionStorage(): Storage {
  if (typeof window === "undefined" || !window.sessionStorage) {
    throw new StorageError("OIDC authorization requires browser session storage");
  }
  return window.sessionStorage;
}

function validateAuthorizationInputs(opts: {
  authMetadata: OidcClientConfig;
  clientId: string;
  homeserverUrl: string;
  redirectUri: string;
  deviceId?: string;
}): { authMetadata: OidcClientConfig; homeserver: URL; redirect: URL; deviceId: string } {
  const authMetadata = validateTrustedAuthMetadata(opts.authMetadata);
  const issuer = new URL(authMetadata.issuer);
  const homeserver = parseHttpUrl(opts.homeserverUrl, "homeserver URL");
  const redirect = parseHttpUrl(opts.redirectUri, "redirect URI");
  if (homeserver.origin !== issuer.origin || redirect.origin !== window.location.origin) {
    throw new StorageError("OIDC authorization context origins are not trusted");
  }
  requireClientId(opts.clientId);
  const deviceId = opts.deviceId ?? randomHex(5).toUpperCase();
  requireString(deviceId, "device ID", DEVICE_ID_PATTERN);
  return { authMetadata, homeserver, redirect, deviceId };
}

function parseAuthorizationContext(value: unknown, expectedState: string): AuthorizationCodeContext {
  if (!isRecord(value) || value.version !== AUTHORIZATION_CONTEXT_VERSION) {
    throw new StorageError("OIDC authorization context is missing or invalid");
  }
  if (value.state !== expectedState) {
    throw new StorageError("OIDC authorization context state does not match callback state");
  }
  if (typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs)) {
    throw new StorageError("OIDC authorization context has an invalid creation time");
  }
  const ageMs = Date.now() - value.createdAtMs;
  if (ageMs < -AUTHORIZATION_CONTEXT_MAX_FUTURE_SKEW_MS) {
    throw new StorageError("OIDC authorization context is from the future");
  }
  if (ageMs > AUTHORIZATION_CONTEXT_MAX_AGE_MS) {
    throw new StorageError("OIDC authorization context is expired");
  }
  const authMetadata = validateTrustedAuthMetadata(value.authMetadata);
  const homeserver = parseHttpUrl(value.homeserverUrl, "homeserver URL");
  const redirect = parseHttpUrl(value.redirectUri, "redirect URI");
  if (homeserver.origin !== new URL(authMetadata.issuer).origin || redirect.origin !== window.location.origin) {
    throw new StorageError("OIDC authorization context origins are not trusted");
  }
  return {
    version: AUTHORIZATION_CONTEXT_VERSION,
    createdAtMs: value.createdAtMs,
    state: expectedState,
    authMetadata,
    clientId: requireClientId(value.clientId),
    redirectUri: redirect.toString(),
    homeserverUrl: homeserver.toString(),
    deviceId: requireString(value.deviceId, "device ID", DEVICE_ID_PATTERN),
    codeVerifier: requireString(value.codeVerifier, "PKCE verifier", PKCE_VERIFIER_PATTERN),
  };
}

/**
 * Discovers the OIDC/MAS issuer and endpoints for a homeserver via the
 * Matrix client's stable `/auth_metadata` endpoint. Matrix 42 performs this
 * as a plain metadata fetch; discovery is safe for browser and Node callers.
 */
export async function discoverOidcIssuer(
  homeserverBaseUrl: string,
  signal?: AbortSignal,
): Promise<OidcClientConfig> {
  try {
    const homeserver = parseHttpUrl(homeserverBaseUrl, "homeserver URL");
    const endpoint = matrixAuthMetadataEndpoint(homeserver);
    const { response, body } = await requestWithTimeout(
      endpoint,
      { method: "GET", headers: { Accept: "application/json" }, redirect: "manual" },
      "discovery",
      async (response, requestSignal) => {
        assertNoRedirect(response, endpoint, "discovery");
        if (!response.ok) {
          // Discovery only consumes metadata on success. Drain a bounded
          // error body without parsing or surfacing provider-controlled text;
          // the status remains the only caller-visible diagnostic.
          await readBoundedResponseBody(response, MAX_OAUTH_ERROR_BODY_BYTES, requestSignal);
          return { response, body: undefined };
        }
        return {
          response,
          body: await readBoundedJsonResponse(response, "discovery", requestSignal),
        };
      },
      OIDC_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) {
      const failure = new StorageError("OIDC discovery failed") as StorageError & { httpStatus: number };
      failure.httpStatus = response.status;
      throw failure;
    }
    ensureOidcNotCancelled(signal, "discovery");
    return validateTrustedAuthMetadata(body);
  } catch (err) {
    throw new StorageError(formatProviderFailure("discovery", err));
  }
}

/**
 * Dynamic client registration (DCR). `clientUri`/`redirectUris` must share a
 * host unless the issuer's policy allows a mismatch (our local dev/test MAS
 * does; a production issuer may not).
 */
export async function registerClient(
  authMetadata: OidcClientConfig,
  metadata: OidcRegistrationClientMetadata,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const safeAuthMetadata = validateTrustedAuthMetadata(authMetadata);
    const safeMetadata = validateRegistrationMetadata(metadata);
    const defaultGrantTypes: string[] = [
      OAuthGrantType.AuthorizationCode,
      OAuthGrantType.RefreshToken,
    ];
    if (safeAuthMetadata.grant_types_supported.includes(OAuthGrantType.DeviceAuthorization)) {
      defaultGrantTypes.push(OAuthGrantType.DeviceAuthorization);
    }
    const grantTypes = defaultGrantTypes;
    if (grantTypes.some((grantType) => !safeAuthMetadata.grant_types_supported.includes(grantType))) {
      throw new StorageError("OIDC dynamic client registration is not supported");
    }
    const registration: OAuthRegistrationRequest = {
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: metadata.clientName,
      client_uri: safeMetadata.clientUri.toString(),
      grant_types: grantTypes as [string, ...string[]],
      logo_uri: metadata.logoUri,
      application_type: metadata.applicationType,
      redirect_uris: safeMetadata.redirectUris,
      tos_uri: metadata.tosUri,
      policy_uri: metadata.policyUri,
    };
    const endpoint = exactEndpoint(safeAuthMetadata.registration_endpoint, "registration endpoint");
    const { response, body } = await requestWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(registration),
        redirect: "manual",
      },
      "dynamic client registration",
      async (response, requestSignal) => {
        assertNoRedirect(response, endpoint, "dynamic client registration");
        return {
          response,
          body: await readBoundedJsonResponse(response, "dynamic client registration", requestSignal),
        };
      },
      OIDC_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (!response.ok || !validateRegistrationResponse(body)) {
      throw new StorageError("OIDC dynamic client registration failed");
    }
    ensureOidcNotCancelled(signal, "dynamic client registration");
    return requireClientId(body.client_id);
  } catch (err) {
    throw new StorageError(formatProviderFailure("dynamic client registration", err));
  }
}

// ---------------------------------------------------------------------------
// Device-code grant (RFC 8628) — the CLI's login flow. Plain `fetch` calls
// under the hood (matrix-js-sdk's supported OAuth helpers), nothing
// browser-only.
// ---------------------------------------------------------------------------

/**
 * Starts a device-code authorization session. `deviceId` is caller-chosen
 * (unlike the authorization-code flow, where the SDK picks a random one) so
 * it can be reused as this Matrix device's `device_id` throughout —
 * `generateScope(deviceId)` embeds it in the requested stable Matrix OAuth
 * scope.
 */
export async function startDeviceCodeLogin(
  authMetadata: OidcClientConfig,
  clientId: string,
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
  try {
    const safeAuthMetadata = validateTrustedAuthMetadata(authMetadata);
    const safeClientId = requireClientId(clientId);
    requireString(deviceId, "device ID", DEVICE_ID_PATTERN);
    const scope = generateScope(deviceId);
    const endpoint = safeAuthMetadata.device_authorization_endpoint;
    if (!endpoint) throw new StorageError("OIDC device authorization is not supported");
    const trustedEndpoint = exactEndpoint(endpoint, "device authorization endpoint");
    const { response, body } = await requestWithTimeout(
      trustedEndpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: safeClientId, scope }).toString(),
        redirect: "manual",
      },
      "device authorization",
      async (response, requestSignal) => {
        assertNoRedirect(response, trustedEndpoint, "device authorization");
        return {
          response,
          body: await readBoundedJsonResponse(response, "device authorization", requestSignal),
        };
      },
      OIDC_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) throw new StorageError("OIDC device authorization failed");
    const session = validateDeviceAuthorizationSession(body);
    ensureOidcNotCancelled(signal, "device authorization");
    // Keep the requested device binding attached to this in-memory session
    // without changing the RFC response shape or serializing it into logs.
    deviceAuthorizationDeviceIds.set(session as unknown as object, deviceId);
    return session;
  } catch (err) {
    throw new StorageError(formatProviderFailure("device authorization", err));
  }
}

/**
 * Polls the token endpoint until the device-code session is approved (or
 * denied/expired) — see matrix-js-sdk's `waitForDeviceAuthorization` for the
 * RFC 8628 polling semantics (honours `interval`/`expires_in`,
 * `authorization_pending`/`slow_down`). Sessions returned by
 * startDeviceCodeLogin carry their binding in memory; reconstructed sessions
 * must provide expectedDeviceId and are rejected before polling when no
 * binding is available.
 */
export async function waitForDeviceCodeLogin(
  authMetadata: OidcClientConfig,
  clientId: string,
  session: DeviceAuthorizationResponse,
  signal?: AbortSignal,
  expectedDeviceId?: string,
): Promise<DeviceAccessTokenResponse | DeviceAccessTokenError> {
  try {
    if (signal?.aborted) throw new OidcRequestCancelledError("device authorization");
    const safeAuthMetadata = validateTrustedAuthMetadata(authMetadata);
    const safeClientId = requireClientId(clientId);
    const safeSession = validateDeviceAuthorizationSession(session);
    const requestedDeviceId = expectedDeviceId ?? deviceAuthorizationDeviceIds.get(session as unknown as object);
    if (requestedDeviceId === undefined) {
      throw new StorageError("OIDC device authorization requires an expected device ID");
    }
    requireString(requestedDeviceId, "device ID", DEVICE_ID_PATTERN);
    const endpoint = exactEndpoint(safeAuthMetadata.token_endpoint, "token endpoint");
    let interval = (safeSession.interval ?? 5) * 1000;
    const expiration = Date.now() + Math.min(safeSession.expires_in * 1000, MAX_DEVICE_POLL_DURATION_MS);
    do {
      const remaining = expiration - Date.now();
      if (remaining <= 0) {
        ensureOidcNotCancelled(signal, "device authorization");
        return { error: "expired" };
      }
      const { response, body } = await requestWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            device_code: safeSession.device_code,
            grant_type: OAuthGrantType.DeviceAuthorization,
            client_id: safeClientId,
          }).toString(),
          redirect: "manual",
        },
        "device authorization",
        async (response, requestSignal) => {
          assertNoRedirect(response, endpoint, "device authorization");
          return {
            response,
            body: await readBoundedJsonResponse(response, "device authorization", requestSignal),
          };
        },
        Math.min(OIDC_REQUEST_TIMEOUT_MS, remaining),
        signal,
      );
      if (response.ok && isValidDeviceAccessTokenResponse(body)) {
        const tokenResponse = validateDeviceAccessTokenResponse(body);
        if (
          !requestedDeviceId ||
          typeof tokenResponse.scope !== "string" ||
          !scopeMatchesDevice(tokenResponse.scope, requestedDeviceId)
        ) {
          throw new OidcValidationError("OIDC device authorization returned an unexpected granted scope");
        }
        ensureOidcNotCancelled(signal, "device authorization");
        return tokenResponse;
      }
      const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
      switch (error) {
        case "authorization_pending":
          break;
        case "slow_down":
          interval += 5000;
          break;
        case "access_denied":
        case "expired_token":
          ensureOidcNotCancelled(signal, "device authorization");
          return { error: SAFE_OAUTH_ERROR_CODES.has(error) ? error : "provider_error" };
        default:
          ensureOidcNotCancelled(signal, "device authorization");
          return { error: "provider_error" };
      }
      await abortableDelay(Math.min(interval, Math.max(0, expiration - Date.now())), signal);
    } while (Date.now() < expiration);
    ensureOidcNotCancelled(signal, "device authorization");
    return { error: "expired" };
  } catch (err) {
    if (err instanceof OidcValidationError) throw err;
    throw new StorageError(formatProviderFailure("device authorization", err));
  }
}

export function isDeviceAccessTokenError(
  result: DeviceAccessTokenResponse | DeviceAccessTokenError,
): result is DeviceAccessTokenError {
  return typeof (result as DeviceAccessTokenError).error === "string";
}

// ---------------------------------------------------------------------------
// Authorization code + PKCE — the web UI's login flow. Browser-only when
// actually called because its one-time context is held in sessionStorage —
// never called from the CLI.
// ---------------------------------------------------------------------------

/**
 * Builds the authorization URL to redirect the browser to. The Matrix 42
 * OAuth2 helper owns PKCE challenge generation and URL construction; this
 * SDK owns only the minimal context needed to recreate that helper after the
 * redirect. The context is keyed by a one-time random state in sessionStorage.
 */
export async function beginAuthorizationCodeFlow(opts: {
  authMetadata: OidcClientConfig;
  clientId: string;
  homeserverUrl: string;
  redirectUri: string;
  deviceId?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (opts.signal?.aborted) throw new StorageError("OIDC authorization cancelled");
  const { authMetadata, homeserver, redirect, deviceId } = validateAuthorizationInputs(opts);
  const createdAtMs = Date.now();
  const state = randomHex(32);
  const codeVerifier = randomHex(64);
  const oauth = new OAuth2(authMetadata as ValidatedAuthMetadata, {
    clientId: opts.clientId,
    deviceId,
    codeVerifier,
    redirectUri: redirect.toString(),
  });
  const url = await oauth.generateAuthorizationCodeGrantUrl(state, "query");
  if (opts.signal?.aborted) throw new StorageError("OIDC authorization cancelled");
  let generated: URL;
  try {
    generated = new URL(url);
  } catch {
    throw new StorageError("OIDC authorization URL is invalid");
  }
  const expectedEndpoint = parseHttpUrl(authMetadata.authorization_endpoint, "authorization endpoint");
  const stateValues = generated.searchParams.getAll("state");
  if (
    generated.origin !== expectedEndpoint.origin ||
    generated.pathname !== expectedEndpoint.pathname ||
    generated.username !== "" ||
    generated.password !== "" ||
    generated.hash !== "" ||
    stateValues.length !== 1 ||
    stateValues[0] !== state ||
    generated.searchParams.getAll("redirect_uri").length !== 1 ||
    generated.searchParams.get("redirect_uri") !== redirect.toString()
  ) {
    throw new StorageError("OIDC authorization URL is not bound to the validated request");
  }
  const context: AuthorizationCodeContext = {
    version: AUTHORIZATION_CONTEXT_VERSION,
    createdAtMs,
    state,
    authMetadata,
    clientId: opts.clientId,
    redirectUri: redirect.toString(),
    homeserverUrl: homeserver.toString(),
    deviceId,
    codeVerifier,
  };
  sessionStorage().setItem(`${AUTHORIZATION_CONTEXT_PREFIX}${state}`, JSON.stringify(context));
  return url;
}

/** Completes the authorization-code exchange after the `?code&state` redirect. */
export async function completeAuthorizationCodeFlow(
  code: string,
  state: string,
  signal?: AbortSignal,
): Promise<{
  tokenResponse: BearerTokenResponse;
  oidcClientSettings: { clientId: string; issuer: string };
  homeserverUrl: string;
}> {
  requireString(state, "authorization state", STATE_PATTERN);
  const store = sessionStorage();
  const key = `${AUTHORIZATION_CONTEXT_PREFIX}${state}`;
  const serialized = store.getItem(key);
  if (!serialized) throw new StorageError("OIDC authorization context is missing or expired");
  if (serialized.length > MAX_AUTHORIZATION_CONTEXT_LENGTH) {
    store.removeItem(key);
    throw new StorageError("OIDC authorization context is too large");
  }

  let context: AuthorizationCodeContext;
  try {
    context = parseAuthorizationContext(JSON.parse(serialized), state);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("OIDC authorization context is missing or invalid");
  } finally {
    // Consume the state before any network exchange. A retry must not replay
    // the authorization code, even if the exchange fails.
    store.removeItem(key);
  }

  try {
    requireBoundedString(code, "authorization code", MAX_OIDC_CODE_LENGTH);
    const endpoint = exactEndpoint(context.authMetadata.token_endpoint, "token endpoint");
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: context.clientId,
      code_verifier: context.codeVerifier,
      redirect_uri: context.redirectUri,
      code,
    });
    const { response, body } = await requestWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: params.toString(),
        redirect: "manual",
      },
      "authorization code exchange",
      async (response, requestSignal) => {
        assertNoRedirect(response, endpoint, "authorization code exchange");
        return {
          response,
          body: await readBoundedJsonResponse(response, "authorization code exchange", requestSignal),
        };
      },
      OIDC_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) throw new StorageError("OIDC authorization code exchange failed");
    validateBearerTokenResponse(body);
    validateTokenBounds(body, "authorization code exchange");
    const normalized = normalizeBearerTokenResponseTokenType(body);
    const grantedScope = normalized.scope;
    if (typeof grantedScope !== "string" || !scopeMatchesDevice(grantedScope, context.deviceId)) {
      throw new StorageError("OIDC authorization code exchange returned an unexpected granted scope");
    }
    const tokenResponse: BearerTokenResponse = {
      ...normalized,
      scope: grantedScope,
    };
    ensureOidcNotCancelled(signal, "authorization code exchange");
    return {
      tokenResponse,
      oidcClientSettings: { clientId: context.clientId, issuer: context.authMetadata.issuer },
      homeserverUrl: context.homeserverUrl,
    };
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(formatProviderFailure("authorization code exchange", err));
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The device_id granted is embedded in the token response's stable Matrix
 * OAuth scope. */
export function extractDeviceIdFromScope(scope: string): string | null {
  if (
    typeof scope !== "string" ||
    scope.length > MAX_OIDC_SCOPE_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(scope) ||
    scope.trim() !== scope
  ) {
    return null;
  }
  const tokens = scope.split(/\s+/);
  const deviceTokens = tokens.filter((token) =>
    MATRIX_SCOPE_PREFIXES.some((prefix) => token.startsWith(`${prefix}device:`)),
  );
  if (deviceTokens.length !== 1) return null;
  const deviceToken = deviceTokens[0];
  const prefix = MATRIX_SCOPE_PREFIXES.find((candidate) => deviceToken.startsWith(`${candidate}device:`));
  if (!prefix) return null;
  const deviceId = deviceToken.slice(`${prefix}device:`.length);
  return DEVICE_ID_PATTERN.test(deviceId) ? deviceId : null;
}

/**
 * Accepts the legacy Matrix OAuth scope and the current MSC2967 namespace
 * returned by MAS. The provider may add the standard `openid` scope, but the
 * API and device grants must remain one exact namespace pair bound to the
 * device that this client requested.
 */
function scopeMatchesDevice(scope: string, expectedDeviceId: string): boolean {
  if (
    typeof scope !== "string" ||
    typeof expectedDeviceId !== "string" ||
    !DEVICE_ID_PATTERN.test(expectedDeviceId) ||
    scope.length === 0 ||
    scope.length > MAX_OIDC_SCOPE_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(scope) ||
    scope.trim() !== scope ||
    /\s{2,}/.test(scope)
  ) {
    return false;
  }
  const tokens = scope.split(/\s+/);
  if (new Set(tokens).size !== tokens.length) return false;
  return MATRIX_SCOPE_PREFIXES.some((prefix) => {
    const expected = new Set([
      `${prefix}api:*`,
      `${prefix}device:${expectedDeviceId}`,
      "openid",
    ]);
    const required = new Set([
      `${prefix}api:*`,
      `${prefix}device:${expectedDeviceId}`,
    ]);
    return (
      tokens.length >= required.size &&
      tokens.length <= expected.size &&
      tokens.every((token) => expected.has(token)) &&
      [...required].every((token) => tokens.includes(token))
    );
  });
}

function validateMatrixUserId(userId: unknown, serverName: string): string {
  try {
    return validateCanonicalMatrixUserId(userId, serverName);
  } catch {
    throw new StorageError("OIDC identity confirmation returned an invalid or foreign user ID");
  }
}

/** Confirms {userId, deviceId} for a freshly-obtained access token via
 * `GET /_matrix/client/v3/account/whoami` — needed because neither the
 * device-code nor authorization-code token response includes the Matrix
 * user ID. */
export async function whoAmI(
  homeserverUrl: string,
  accessToken: string,
  serverName: string,
  signal?: AbortSignal,
): Promise<{ userId: string; deviceId: string | null }> {
  try {
    const homeserver = parseHttpUrl(homeserverUrl, "homeserver URL");
    const baseUrl = homeserver.toString();
    requireBoundedString(accessToken, "access token", MAX_OIDC_TOKEN_LENGTH);
    const client = createClient({
      baseUrl,
      accessToken,
      localTimeoutMs: OIDC_REQUEST_TIMEOUT_MS,
      fetchFn: boundedMatrixFetch("identity confirmation", signal),
    });
    const res = await client.whoami();
    const userId = validateMatrixUserId(res?.user_id, serverName);
    if (res.device_id !== undefined && res.device_id !== null) {
      try {
        validateMatrixDeviceId(res.device_id);
      } catch {
        throw new StorageError("OIDC identity confirmation returned an invalid device ID");
      }
    }
    if (signal?.aborted) throw new OidcRequestCancelledError("identity confirmation");
    return { userId, deviceId: res.device_id ?? null };
  } catch (err) {
    if (signal?.aborted) {
      throw new StorageError("OIDC identity confirmation cancelled");
    }
    if (err instanceof StorageError) throw err;
    throw new StorageError(formatProviderFailure("identity confirmation", err));
  }
}

/**
 * Refreshes an access token via a plain RFC 6749 `grant_type=refresh_token`
 * POST to the token endpoint. A public client (`token_endpoint_auth_method:
 * "none"`, what `registerClient` above registers) authenticates a refresh
 * with just `client_id` in the body, no secret. This narrow request remains
 * local because Matrix 42's `OAuth2.performRefreshTokenGrant` parses every
 * non-success body with unbounded `response.json()`; this path bounds the
 * body and exposes only an allowlisted OAuth error code.
 */
async function refreshOidcToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  expectedDeviceId: string,
  signal?: AbortSignal,
): Promise<AccessTokens> {
  const endpoint = exactEndpoint(tokenEndpoint, "token endpoint");
  const safeClientId = requireClientId(clientId);
  const safeRefreshToken = requireBoundedString(refreshToken, "refresh token", MAX_OIDC_TOKEN_LENGTH);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OIDC_REFRESH_TIMEOUT_MS);
  const abortExternal = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortExternal();
  else signal?.addEventListener("abort", abortExternal, { once: true });
  try {
    const res = await raceWithAbort(
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: safeRefreshToken,
          client_id: safeClientId,
        }).toString(),
        signal: controller.signal,
        redirect: "manual",
      }),
      controller.signal,
      () => undefined,
      () =>
        signal?.aborted
          ? new StorageError("OIDC token refresh cancelled")
          : new StorageError("OIDC token refresh timed out"),
    );
    assertNoRedirect(res, endpoint, "token refresh");
    if (!res.ok) {
      let body: BoundedResponseText;
      try {
        body = await readBoundedResponseText(res, MAX_OAUTH_ERROR_BODY_BYTES, controller.signal);
      } catch (error) {
        if (signal?.aborted || controller.signal.aborted) throw error;
        body = { text: "", truncated: false };
      }
      throw new StorageError(formatTokenRefreshFailure(res.status, body));
    }
    const body = await readBoundedResponseText(res, MAX_OAUTH_SUCCESS_BODY_BYTES, controller.signal);
    if (body.truncated) {
      throw new StorageError("OIDC token refresh returned an oversized response");
    }
    let data: unknown;
    try {
      data = JSON.parse(body.text);
    } catch {
      throw new StorageError("OIDC token refresh returned an invalid response");
    }
    if (!data || typeof data !== "object") {
      throw new StorageError("OIDC token refresh returned an invalid response");
    }
    const record = data as Record<string, unknown>;
    const accessToken = record.access_token;
    const nextRefreshToken = record.refresh_token;
    const grantedScope = record.scope;
    const expiresIn = record.expires_in;
    if (
      typeof accessToken !== "string" ||
      accessToken.trim() === "" ||
      accessToken.length > MAX_OIDC_TOKEN_LENGTH ||
      /[\s\u0000-\u001f\u007f]/.test(accessToken)
    ) {
      throw new StorageError("OIDC token refresh returned no access token");
    }
    const tokenType = record.token_type;
    if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
      throw new StorageError("OIDC token refresh returned an invalid token type");
    }
    if (
      nextRefreshToken !== undefined &&
      (typeof nextRefreshToken !== "string" ||
        nextRefreshToken.trim() === "" ||
        nextRefreshToken.length > MAX_OIDC_TOKEN_LENGTH ||
        /[\s\u0000-\u001f\u007f]/.test(nextRefreshToken))
    ) {
      throw new StorageError("OIDC token refresh returned an invalid refresh token");
    }
    if (grantedScope !== undefined) {
      if (typeof grantedScope !== "string") {
        throw new StorageError("OIDC token refresh returned an invalid scope");
      }
      try {
        requireScope(grantedScope, "scope");
      } catch {
        throw new StorageError("OIDC token refresh returned an invalid scope");
      }
      if (!scopeMatchesDevice(grantedScope, expectedDeviceId)) {
        throw new StorageError("OIDC token refresh returned an unexpected granted scope");
      }
    } else {
      throw new StorageError("OIDC token refresh returned no device-bound scope");
    }
    if (
      expiresIn !== undefined &&
      (typeof expiresIn !== "number" ||
        !Number.isInteger(expiresIn) ||
        expiresIn < 0 ||
        expiresIn > 86400)
    ) {
      throw new StorageError("OIDC token refresh returned an invalid expiry");
    }
    ensureOidcNotCancelled(signal, "token refresh");
    return {
      accessToken,
      // RFC 6749 permits the provider to omit refresh_token when it remains
      // valid. Preserve the token that authorized this grant in that case.
      refreshToken: nextRefreshToken === undefined ? safeRefreshToken : nextRefreshToken,
      expiry:
        expiresIn === undefined
          ? undefined
          : new Date(Date.now() + expiresIn * 1000),
    };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (signal?.aborted) {
      throw new StorageError("OIDC token refresh cancelled");
    }
    if (controller.signal.aborted) {
      throw new StorageError("OIDC token refresh timed out");
    }
    throw new StorageError("OIDC token refresh failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortExternal);
  }
}

/** Revokes a token after a caller-side session commit fails or becomes stale. */
async function revokeOidcToken(
  revocationEndpoint: string,
  clientId: string,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token" = "access_token",
  signal?: AbortSignal,
): Promise<void> {
  const endpoint = exactEndpoint(revocationEndpoint, "revocation endpoint");
  const safeClientId = requireClientId(clientId);
  const safeToken = requireBoundedString(token, "token", MAX_OIDC_TOKEN_LENGTH);
  const { response } = await requestWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: safeClientId,
        token: safeToken,
        token_type_hint: tokenTypeHint,
      }).toString(),
      redirect: "manual",
    },
    "token revocation",
    async (res, requestSignal) => {
      assertNoRedirect(res, endpoint, "token revocation");
      if (!res.ok) {
        await readBoundedResponseText(res, MAX_OAUTH_ERROR_BODY_BYTES, requestSignal);
      } else {
        await readBoundedResponseText(res, MAX_OAUTH_SUCCESS_BODY_BYTES, requestSignal);
      }
      return { response: res };
    },
    OIDC_REQUEST_TIMEOUT_MS,
    signal,
  );
  if (!response.ok) throw new StorageError("OIDC token revocation failed");
}

async function persistOidcTokens(
  onPersist: (
    tokens: { accessToken: string; refreshToken?: string },
    signal?: AbortSignal,
  ) => Promise<void>,
  tokens: { accessToken: string; refreshToken?: string },
  externalSignal?: AbortSignal,
): Promise<void> {
  if (externalSignal?.aborted) throw new OidcRequestCancelledError("token persistence");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, OIDC_REFRESH_TIMEOUT_MS);
  const abortExternal = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener("abort", abortExternal, { once: true });
  try {
    // Promise.resolve().then() also observes synchronous callback throws and
    // lets raceWithAbort attach a rejection handler before a late adapter
    // rejection can become unhandled after the bounded call has settled.
    await raceWithAbort(
      Promise.resolve().then(() => onPersist(tokens, controller.signal)),
      controller.signal,
      () => undefined,
      () =>
        timedOut
          ? new OidcRequestTimeoutError("token persistence")
          : new OidcRequestCancelledError("token persistence"),
    );
    // The persistence promise and the caller signal can settle in either
    // order. Never report success from the narrow window where persistence
    // won the promise race but the caller has already cancelled.
    if (externalSignal?.aborted) throw new OidcRequestCancelledError("token persistence");
  } catch (error) {
    if (timedOut) throw new OidcRequestTimeoutError("token persistence");
    if (externalSignal?.aborted) throw new OidcRequestCancelledError("token persistence");
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortExternal);
  }
}

function createOidcCleanupSignal(): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OIDC_CLEANUP_TIMEOUT_MS);
  return { signal: controller.signal, close: () => clearTimeout(timeout) };
}

/**
 * Builds the `tokenRefreshFunction` `TeleCryptIOStorage.createFromOidc`
 * expects: refreshes via the internal OAuth request, then calls `onPersist`
 * with the new tokens before returning them — so a caller's adapter-specific
 * persistence (CLI: profile file; UI: localStorage) always sees a refresh
 * that just happened, not just ones it initiated itself.
 */
export function buildTokenRefreshFunction(
  metadata: OidcTokenEndpointMetadata,
  clientId: string,
  onPersist: (
    tokens: { accessToken: string; refreshToken?: string },
    signal?: AbortSignal,
  ) => Promise<void>,
  expectedDeviceId: string,
): TokenRefreshFunction & ((refreshToken: string, signal?: AbortSignal) => Promise<AccessTokens>) {
  // Store canonical endpoints bound to the same validated issuer for the
  // lifetime of this callback. Callers cannot provide an arbitrary HTTPS
  // endpoint and cause a refresh or revocation token to leave that issuer.
  const { tokenEndpoint: endpoint, revocationEndpoint } = validateTokenEndpointMetadata(metadata);
  const safeClientId = requireClientId(clientId);
  const safeExpectedDeviceId = requireString(expectedDeviceId, "device ID", DEVICE_ID_PATTERN);
  return async (refreshToken: string, signal?: AbortSignal) => {
    const tokens = await refreshOidcToken(endpoint, safeClientId, refreshToken, safeExpectedDeviceId, signal);
    try {
      await persistOidcTokens(
        onPersist,
        { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
        signal,
      );
    } catch {
      if (revocationEndpoint) {
        // Cleanup must remain possible even when the caller's signal is
        // already aborted. Use a separate bounded signal so persistence
        // failure cannot strand freshly-issued tokens merely because the
        // original request was cancelled.
        const cleanup = createOidcCleanupSignal();
        try {
          await revokeOidcToken(
            revocationEndpoint,
            safeClientId,
            tokens.accessToken,
            "access_token",
            cleanup.signal,
          );
          if (tokens.refreshToken) {
            await revokeOidcToken(
              revocationEndpoint,
              safeClientId,
              tokens.refreshToken,
              "refresh_token",
              cleanup.signal,
            );
          }
        } catch {
          cleanup.close();
          throw new StorageError("OIDC token persistence failed and session cleanup was incomplete");
        }
        cleanup.close();
      }
      throw new StorageError("OIDC token persistence failed; discard the refreshed session");
    }
    ensureOidcNotCancelled(signal, "token refresh");
    return tokens;
  };
}
