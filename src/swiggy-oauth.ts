/**
 * Swiggy OAuth 2.1 + PKCE provider.
 *
 * Implements the authorization_code flow with PKCE (S256) as documented at:
 * https://mcp.swiggy.com/builders/docs/start/authenticate.md
 *
 * OAuth server metadata verified live from:
 * https://mcp.swiggy.com/.well-known/oauth-authorization-server
 *
 * Key v1.0 constraints:
 * - No refresh tokens (re-run full flow on 401)
 * - Access token lifetime: 5 days (432000 seconds)
 * - Dynamic Client Registration via POST /auth/register
 * - Code challenge method: S256 only
 */

import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import open from "open";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenStore {
  access_token: string;
  expires_at: number; // Unix ms
  scope: string;
}

interface DCRResponse {
  client_id: string;
  client_secret?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SWIGGY_ISSUER = "https://mcp.swiggy.com/auth";
const AUTHORIZE_URL = `${SWIGGY_ISSUER}/authorize`;
const TOKEN_URL = `${SWIGGY_ISSUER}/token`;
const REGISTER_URL = `${SWIGGY_ISSUER}/register`;

const REDIRECT_PORT = parseInt(process.env.OAUTH_REDIRECT_PORT ?? "3000", 10);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPE = "mcp:tools mcp:resources mcp:prompts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_STORE_PATH = path.resolve(__dirname, "..", "token-store.json");

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// ─── Token persistence ────────────────────────────────────────────────────────

async function loadStoredToken(): Promise<TokenStore | null> {
  try {
    const raw = await fs.readFile(TOKEN_STORE_PATH, "utf-8");
    const store: TokenStore = JSON.parse(raw);
    // Require at least 60 seconds of remaining validity
    if (store.access_token && store.expires_at > Date.now() + 60_000) {
      return store;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveToken(token: TokenResponse): Promise<void> {
  const store: TokenStore = {
    access_token: token.access_token,
    expires_at: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  };
  await fs.writeFile(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ─── Dynamic Client Registration ──────────────────────────────────────────────

async function registerClient(): Promise<string> {
  const res = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Swigg MCP Nutrition Agent",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client — no secret
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DCR failed (${res.status}): ${err}`);
  }

  const dcr = (await res.json()) as DCRResponse;
  return dcr.client_id;
}

// ─── Local callback server ────────────────────────────────────────────────────

function waitForCallback(
  expectedState: string
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = http.createServer(app);

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes."));
    }, 5 * 60 * 1000);

    app.get("/callback", (req, res) => {
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        res.send(
          "<html><body><h2>Authorization failed.</h2><p>" +
            error +
            "</p><p>You may close this tab.</p></body></html>"
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (state !== expectedState) {
        res.send(
          "<html><body><h2>State mismatch — possible CSRF.</h2><p>You may close this tab.</p></body></html>"
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error("OAuth state mismatch — possible CSRF attack."));
        return;
      }

      if (!code) {
        res.send(
          "<html><body><h2>No authorization code received.</h2><p>You may close this tab.</p></body></html>"
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error("No authorization code in callback."));
        return;
      }

      res.send(
        "<html><body>" +
          "<h2 style='font-family:sans-serif;color:#FF5200'>✓ Connected to Swiggy!</h2>" +
          "<p style='font-family:sans-serif'>Authorization successful. You may close this tab and return to your terminal.</p>" +
          "</body></html>"
      );

      clearTimeout(timeout);
      server.close();
      resolve({ code, state });
    });

    server.listen(REDIRECT_PORT, () => {
      // Server is ready — browser will be opened by the caller
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  clientId: string
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
  }

  return (await res.json()) as TokenResponse;
}

// ─── Main public API ──────────────────────────────────────────────────────────

/**
 * Returns a valid Swiggy access token.
 *
 * Strategy:
 * 1. Try to reuse a stored token (if still valid).
 * 2. If not, run the full OAuth 2.1 + PKCE flow (browser + phone + OTP).
 */
export async function getSwiggyAccessToken(): Promise<string> {
  // 1. Try stored token
  const stored = await loadStoredToken();
  if (stored) {
    const remainingMs = stored.expires_at - Date.now();
    const remainingDays = Math.round(remainingMs / (1000 * 60 * 60 * 24));
    console.log(
      `✓ Using stored Swiggy token (expires in ~${remainingDays} day(s)).`
    );
    return stored.access_token;
  }

  // 2. Run full OAuth flow
  console.log("\n🔑 No valid Swiggy token found. Starting OAuth flow...");

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Dynamic Client Registration
  console.log("   Registering OAuth client...");
  const clientId = await registerClient();
  console.log(`   Client registered: ${clientId.slice(0, 12)}...`);

  // Build authorization URL
  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", SCOPE);

  // Start callback listener first, then open browser
  const callbackPromise = waitForCallback(state);

  console.log("\n   Opening Swiggy authorization in your browser...");
  console.log(`   URL: ${authUrl.toString()}\n`);
  await open(authUrl.toString());

  console.log(
    "   Waiting for you to complete phone + OTP login in the browser..."
  );
  const { code } = await callbackPromise;
  console.log("   ✓ Authorization code received.");

  // Exchange code for token
  console.log("   Exchanging code for access token...");
  const tokenResponse = await exchangeCodeForToken(code, codeVerifier, clientId);

  // Persist token
  await saveToken(tokenResponse);
  const expiryDays = Math.round(tokenResponse.expires_in / 86400);
  console.log(
    `✓ Swiggy token obtained. Valid for ${expiryDays} days.\n`
  );

  return tokenResponse.access_token;
}

/**
 * Returns request headers needed for authenticated Swiggy MCP calls.
 * Use this when constructing MCPServerStreamableHttp with requestInit.
 */
export async function getSwiggyAuthHeaders(): Promise<Record<string, string>> {
  const token = await getSwiggyAccessToken();
  return {
    Authorization: `Bearer ${token}`,
  };
}
