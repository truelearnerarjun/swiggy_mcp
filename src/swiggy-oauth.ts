/** Swiggy OAuth 2.1 + PKCE helpers for CLI and delegated WhatsApp auth. */
import crypto from "crypto";

const SWIGGY_ISSUER = "https://mcp.swiggy.com/auth";
const AUTHORIZE_URL = `${SWIGGY_ISSUER}/authorize`;
const TOKEN_URL = `${SWIGGY_ISSUER}/token`;
const REGISTER_URL = `${SWIGGY_ISSUER}/register`;
const SCOPE = "mcp:tools mcp:resources mcp:prompts";
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

interface TokenStore {
  access_token: string;
  expires_at: number;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface PendingAuthorization {
  phoneNumber: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

const tokensByPhone = new Map<string, TokenStore>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

async function registerClient(redirectUri: string): Promise<string> {
  const response = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Swiggy MCP Nutrition Agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!response.ok) {
    throw new Error(`Swiggy client registration failed (${response.status}).`);
  }
  const data = (await response.json()) as { client_id?: string };
  if (!data.client_id) throw new Error("Swiggy registration did not return a client ID.");
  return data.client_id;
}

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Swiggy token exchange failed (${response.status}).`);
  }
  return (await response.json()) as TokenResponse;
}

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_STORE_PATH = path.resolve(__dirname, "..", "token-store.json");

export async function loadStoredToken(): Promise<TokenStore | null> {
  try {
    const raw = await fs.readFile(TOKEN_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as TokenStore;
    if (validToken(parsed)) return parsed;
  } catch {
    // not found or invalid
  }
  return null;
}

export async function saveToken(tokenResponse: TokenResponse): Promise<void> {
  const store: TokenStore = {
    access_token: tokenResponse.access_token,
    expires_at: Date.now() + tokenResponse.expires_in * 1000,
    scope: tokenResponse.scope,
  };
  await fs.writeFile(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function validToken(token: TokenStore | undefined): token is TokenStore {
  return Boolean(token?.access_token && token.expires_at > Date.now() + 60_000);
}

/** Returns a non-expired, in-memory token for one WhatsApp sender. */
export function getPhoneSwiggyAccessToken(phoneNumber: string): string | null {
  const token = tokensByPhone.get(phoneNumber);
  if (validToken(token)) return token.access_token;
  tokensByPhone.delete(phoneNumber);
  return null;
}

/**
 * Returns a valid token for a phone number or falls back to system token:
 * 1. If user has a per-phone token in tokensByPhone, use it.
 * 2. Otherwise fall back to process.env.SWIGGY_ACCESS_TOKEN.
 * 3. Otherwise fall back to token-store.json.
 */
export async function getEffectiveSwiggyToken(phoneNumber?: string): Promise<string | null> {
  if (phoneNumber) {
    const phoneToken = tokensByPhone.get(phoneNumber);
    if (validToken(phoneToken)) return phoneToken.access_token;
  }
  const envToken = process.env.SWIGGY_ACCESS_TOKEN?.trim();
  if (envToken) return envToken;

  const stored = await loadStoredToken();
  if (stored) return stored.access_token;

  return null;
}

/**
 * Creates a single-use authorization URL for one WhatsApp sender.
 * Tokens deliberately remain in memory; never persist a user's Swiggy token as plaintext.
 */
export async function beginPhoneSwiggyAuthorization(
  phoneNumber: string,
  redirectUri: string
): Promise<string> {
  const callback = new URL(redirectUri);
  if (callback.protocol !== "https:" && callback.hostname !== "localhost") {
    throw new Error("OAUTH_PUBLIC_BASE_URL must use HTTPS outside local development.");
  }

  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const clientId = await registerClient(redirectUri);
  pendingAuthorizations.set(state, {
    phoneNumber,
    codeVerifier,
    clientId,
    redirectUri,
    expiresAt: Date.now() + AUTH_REQUEST_TTL_MS,
  });

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", generateCodeChallenge(codeVerifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", SCOPE);
  return authUrl.toString();
}

/** Completes a callback after validating its one-time CSRF state. */
export async function completePhoneSwiggyAuthorization(input: {
  code?: string;
  state?: string;
  error?: string;
}): Promise<{ phoneNumber: string }> {
  if (input.error) throw new Error(`Swiggy authorization was declined: ${input.error}`);
  if (!input.code || !input.state) throw new Error("The Swiggy callback is missing its authorization details.");

  const pending = pendingAuthorizations.get(input.state);
  pendingAuthorizations.delete(input.state);
  if (!pending || pending.expiresAt <= Date.now()) {
    throw new Error("This Swiggy connect link has expired. Return to WhatsApp and request a new one.");
  }

  const token = await exchangeCodeForToken(
    input.code,
    pending.codeVerifier,
    pending.clientId,
    pending.redirectUri
  );
  tokensByPhone.set(pending.phoneNumber, {
    access_token: token.access_token,
    expires_at: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  });
  await saveToken(token).catch(() => {});
  return { phoneNumber: pending.phoneNumber };
}

export function forgetPhoneSwiggyAccessToken(phoneNumber: string): void {
  tokensByPhone.delete(phoneNumber);
}

/** Returns the effective token or throws if none configured. */
export async function getSwiggyAccessToken(): Promise<string> {
  const token = await getEffectiveSwiggyToken();
  if (token) return token;
  throw new Error("No Swiggy token found. Set SWIGGY_ACCESS_TOKEN or run OAuth.");
}

export async function getSwiggyAuthHeaders(accessToken?: string): Promise<Record<string, string>> {
  const token = accessToken ?? (await getSwiggyAccessToken());
  return { Authorization: `Bearer ${token}` };
}
