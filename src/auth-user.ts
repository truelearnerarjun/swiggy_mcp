/**
 * Swiggy User Pairing CLI
 *
 * Authenticates another user's Swiggy account via localhost:3000 (which Swiggy officially whitelists),
 * stores their personal token, and syncs it to the live Render server.
 *
 * Usage:
 *   npx tsx src/auth-user.ts <phone_number>
 *   Example: npx tsx src/auth-user.ts 919876543210
 */

import "dotenv/config";
import express from "express";
import open from "open";
import { Server } from "http";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  registerClient,
  exchangeCodeForToken,
  storePhoneSwiggyToken,
  normalizePhoneNumber,
  AUTHORIZE_URL,
  SCOPE,
} from "./swiggy-oauth.js";

const PORT = parseInt(process.env.OAUTH_REDIRECT_PORT ?? "3000", 10);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const RENDER_BASE = (process.env.OAUTH_PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "https://swiggy-mcp-j47z.onrender.com").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_SYNC_KEY ?? process.env.META_VERIFY_TOKEN ?? "swiggy_agent_secret";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const rawPhone = args[0];

  if (!rawPhone) {
    console.error("\n❌ Error: Please specify the WhatsApp phone number to authenticate.");
    console.log("👉 Usage: npx tsx src/auth-user.ts <phone_number>");
    console.log("   Example: npx tsx src/auth-user.ts 919876543210\n");
    process.exit(1);
  }

  const phoneNumber = normalizePhoneNumber(rawPhone);
  console.log("═══════════════════════════════════════════════════");
  console.log("  🔐 Swiggy User Authentication & Pairing Tool     ");
  console.log(`  📱 Target User Phone: +${phoneNumber}            `);
  console.log("═══════════════════════════════════════════════════\n");

  console.log("1. Registering OAuth client with Swiggy...");
  const clientId = await registerClient(REDIRECT_URI);
  console.log(`   ✓ Client ID registered: ${clientId.slice(0, 16)}...`);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", SCOPE);

  const app = express();
  let server: Server;

  const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
    app.get("/callback", (req, res) => {
      const code = req.query.code as string;
      const callbackState = req.query.state as string;
      const error = req.query.error as string;

      if (error) {
        res.status(400).send(`<h2>Authentication Failed</h2><p>${error}</p>`);
        reject(new Error(`Swiggy declined authentication: ${error}`));
        return;
      }

      if (!code || callbackState !== state) {
        res.status(400).send("<h2>Invalid Request</h2><p>State mismatch or missing code.</p>");
        reject(new Error("CSRF state mismatch or code missing."));
        return;
      }

      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Swiggy Account Linked</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #0b0f19; color: #fff;">
          <h2 style="color: #fc8019;">🎉 Swiggy Account Successfully Linked!</h2>
          <p>User +${phoneNumber} is now authenticated. You may close this browser window.</p>
        </body>
        </html>
      `);
      resolve({ code });
    });
  });

  server = app.listen(PORT, async () => {
    console.log(`2. Local callback server listening on http://localhost:${PORT}/callback`);
    console.log("\n👉 Opening Swiggy login page in your browser...");
    console.log(`   (Login with +${phoneNumber} using their phone number and OTP)\n`);
    await open(authUrl.toString());
  });

  try {
    const { code } = await callbackPromise;
    console.log("\n3. Received authorization code from Swiggy.");
    console.log("   Exchanging code for 5-day Swiggy JWT token...");

    const tokenResponse = await exchangeCodeForToken(code, codeVerifier, clientId, REDIRECT_URI);
    console.log(`   ✓ Token received! Valid for ${Math.round(tokenResponse.expires_in / 86400)} days.`);

    console.log("4. Saving token locally to tokens/phone-tokens.json...");
    await storePhoneSwiggyToken(phoneNumber, tokenResponse.access_token, tokenResponse.expires_in, tokenResponse.scope);
    console.log("   ✓ Saved locally.");

    // Sync to live Render deployment
    if (RENDER_BASE) {
      console.log(`5. Syncing token to Render server (${RENDER_BASE})...`);
      try {
        const syncRes = await fetch(`${RENDER_BASE}/api/sync-user-token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-key": ADMIN_KEY,
          },
          body: JSON.stringify({
            phoneNumber,
            accessToken: tokenResponse.access_token,
            expiresIn: tokenResponse.expires_in,
            scope: tokenResponse.scope,
          }),
        });

        if (syncRes.ok) {
          console.log(`   ✓ Successfully synced to live Render server!`);
          console.log(`   📱 WhatsApp notification dispatched to +${phoneNumber}.`);
        } else {
          const errText = await syncRes.text();
          console.warn(`   ⚠️ Render sync returned HTTP ${syncRes.status}: ${errText}`);
        }
      } catch (err: any) {
        console.warn(`   ⚠️ Could not reach Render server to sync token: ${err?.message ?? err}`);
      }
    }

    console.log("\n═══════════════════════════════════════════════════");
    console.log(`✨ SUCCESS! User +${phoneNumber} is now fully connected.`);
    console.log("   They can now message the bot on WhatsApp and will see:");
    console.log("   - Their OWN saved addresses.");
    console.log("   - Their OWN Swiggy cart & orders.");
    console.log("   - Complete isolation from your admin account.");
    console.log("═══════════════════════════════════════════════════\n");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\n❌ Authentication Error:", err?.message ?? err);
  process.exit(1);
});
