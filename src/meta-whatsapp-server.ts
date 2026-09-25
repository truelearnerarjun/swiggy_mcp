/**
 * AI Nutrition Agent — Official Meta WhatsApp Cloud API Server
 *
 * Implements Meta's Webhook Verification (GET /webhook), incoming message
 * handler (POST /webhook), and sends replies via Meta Graph API.
 */

import "dotenv/config";
import crypto from "crypto";
import express, { Request, Response } from "express";
import { initAgentContext, runAgentTurn, AgentContext } from "./agent-core.js";
import {
  beginPhoneSwiggyAuthorization,
  completePhoneSwiggyAuthorization,
  getPhoneSwiggyAccessToken,
  getEffectiveSwiggyToken,
  forgetPhoneSwiggyAccessToken,
  storePhoneSwiggyToken,
} from "./swiggy-oauth.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN?.trim().replace(/^["']|["']$/g, "");
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID?.trim().replace(/^["']|["']$/g, "");
const META_VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN ?? "swiggy_agent_secret").trim().replace(/^["']|["']$/g, "");

const isMetaConfigured = Boolean(META_WHATSAPP_TOKEN && META_PHONE_NUMBER_ID);
const OAUTH_PUBLIC_BASE_URL = (process.env.OAUTH_PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
const OAUTH_CALLBACK_PATH = "/oauth/swiggy/callback";

// Multi-turn conversation memory keyed by sender phone number
interface UserSession {
  history: any[];
  lastActive: number;
  ctx: AgentContext;
}
const sessions = new Map<string, UserSession>();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [phone, sess] of sessions.entries()) {
    if (now - sess.lastActive > SESSION_TTL_MS) {
      try { sess.ctx?.mcpClient?.close(); } catch {}
      sessions.delete(phone);
    }
  }
}

async function sendWhatsAppMessage(to: string, bodyText: string) {
  if (!isMetaConfigured) {
    console.log(`\n[DEV MODE - META NOT CONFIGURED] Reply for ${to}:\n${bodyText}\n`);
    return;
  }

  // Meta limits text messages to 4096 characters; split if needed
  const chunks = [];
  const maxLen = 4000;
  for (let i = 0; i < bodyText.length; i += maxLen) {
    chunks.push(bodyText.slice(i, i + maxLen));
  }

  for (const chunk of chunks) {
    const url = `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`;
    const tokenHash = crypto.createHash("sha256").update(META_WHATSAPP_TOKEN || "").digest("hex").slice(0, 12);
    console.log(`Sending to Meta API for [${to}] (phoneId: ${META_PHONE_NUMBER_ID}, token len: ${META_WHATSAPP_TOKEN?.length}, tokenHash: ${tokenHash}...)`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body: chunk },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("❌ Meta API Error:", JSON.stringify(data, null, 2));
      } else {
        console.log(`✓ Delivered reply to [${to}]`);
      }
    } catch (err: any) {
      console.error("❌ Failed to send WhatsApp message via Meta:", err?.message ?? err);
    }
  }
}

async function startServer() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  📱 AI Nutrition Agent — Meta WhatsApp Cloud API ");
  console.log("═══════════════════════════════════════════════════\n");

  let ctx: AgentContext | null = null;
  try {
    console.log("🔗 Connecting to Swiggy Food MCP & Gemini...");
    if (process.env.LEGACY_SINGLE_USER_MODE === "1") ctx = await initAgentContext();
    console.log("✓ Connected to Swiggy Food MCP.\n");
  } catch (err: any) {
    console.error("❌  Initialization failed:", err?.message ?? err);
    console.warn("Starting without a shared Swiggy session; WhatsApp users authorize individually.");
  }

  const app = express();
  app.use(express.json());

// In-memory log buffer for remote live diagnostics
const logBuffer: string[] = [];
function addLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logBuffer.push(line);
  if (logBuffer.length > 300) logBuffer.shift();
}
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
console.log = (...args: any[]) => {
  addLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
  origLog(...args);
};
console.error = (...args: any[]) => {
  addLog('ERROR: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
  origErr(...args);
};
console.warn = (...args: any[]) => {
  addLog('WARN: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
  origWarn(...args);
};

// Check Meta Token Validity
async function checkMetaTokenStatus(): Promise<{ valid: boolean; message: string }> {
  if (!isMetaConfigured) {
    return { valid: false, message: "Meta credentials not configured" };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}?fields=id,verified_name`, {
      headers: { Authorization: `Bearer ${META_WHATSAPP_TOKEN}` },
    });
    const data = await res.json();
    if (!res.ok) {
      return { valid: false, message: data.error?.message || "Token invalid or expired" };
    }
    return { valid: true, message: `Verified (${data.verified_name || data.id})` };
  } catch (err: any) {
    return { valid: false, message: err?.message || "Network check failed" };
  }
}

  // Health check
  app.get(["/", "/healthz"], async (_req: Request, res: Response) => {
    const tokenStatus = await checkMetaTokenStatus();
    res.json({
      status: "online",
      agent: "Swiggy AI Nutrition Bot (Meta Cloud API)",
      metaConfigured: isMetaConfigured,
      metaToken: tokenStatus,
      activeSessions: sessions.size,
    });
  });

  // Live remote logs endpoint
  app.get("/logs", (_req: Request, res: Response) => {
    res.type("text/plain").send(logBuffer.join("\n") || "No logs captured yet.");
  });

  app.get(OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    try {
      const { phoneNumber } = await completePhoneSwiggyAuthorization({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      });
      const existing = sessions.get(phoneNumber);
      try { existing?.ctx?.mcpClient?.close(); } catch {}
      sessions.delete(phoneNumber);

      const successHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Swiggy Connected | AI Concierge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #161e2e; border: 1px solid #2d3748; border-radius: 16px; padding: 36px; max-width: 420px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .icon { width: 68px; height: 68px; background: #fc8019; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 34px; color: #fff; }
    h2 { margin: 0 0 12px; color: #ffffff; font-size: 24px; font-weight: 700; }
    p { color: #9ca3af; line-height: 1.6; margin: 0 0 28px; font-size: 15px; }
    .btn { display: inline-block; background: #fc8019; color: #fff; text-decoration: none; font-weight: 600; padding: 14px 28px; border-radius: 10px; font-size: 16px; transition: background 0.2s; }
    .btn:hover { background: #e06d0c; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🍔</div>
    <h2>Swiggy Connected!</h2>
    <p>Your Swiggy account has been linked successfully. Return to WhatsApp to start discovering meals and placing orders.</p>
    <a class="btn" href="https://wa.me/">Return to WhatsApp</a>
  </div>
</body>
</html>`;
      res.type("html").send(successHtml);
      await sendWhatsAppMessage(
        phoneNumber,
        "🎉 *Your Swiggy account is successfully connected!*\n\nWhere should we deliver, and what are you craving today? (e.g. Biryani, Rolls, Pizza, or a healthy High-Protein meal?)"
      );
    } catch (err: any) {
      res.status(400).type("html").send(`<h2>Could not connect Swiggy</h2><p>${err?.message ?? "Authorization failed."}</p><p>Return to WhatsApp and request a new connect link.</p>`);
      console.warn("Swiggy OAuth callback failed:", err?.message ?? err);
    }
  });

  // Secure User Token Sync Endpoint
  app.post("/api/sync-user-token", express.json(), async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"];
    const expectedKey = process.env.ADMIN_SYNC_KEY ?? process.env.META_VERIFY_TOKEN ?? "swiggy_agent_secret";
    if (adminKey !== expectedKey) {
      res.status(401).json({ error: "Unauthorized: Invalid x-admin-key" });
      return;
    }
    const { phoneNumber, accessToken, expiresIn, scope } = req.body;
    if (!phoneNumber || !accessToken) {
      res.status(400).json({ error: "Missing phoneNumber or accessToken" });
      return;
    }
    await storePhoneSwiggyToken(phoneNumber, accessToken, expiresIn ?? 432000, scope ?? "mcp:tools");
    const existing = sessions.get(phoneNumber);
    try { existing?.ctx?.mcpClient?.close(); } catch {}
    sessions.delete(phoneNumber);
    console.log(`✓ Synced personal Swiggy token for [${phoneNumber}]`);
    res.json({ success: true, message: `Token synced for ${phoneNumber}` });
    await sendWhatsAppMessage(
      phoneNumber,
      "🎉 *Your Swiggy account is successfully connected!*\n\nWhere should we deliver, and what are you craving today? (e.g. Biryani, Rolls, Pizza, or a healthy High-Protein meal?)"
    );
  });

  // Meta Webhook Verification (GET /webhook)
  app.get("/webhook", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log("✓ Meta webhook verified successfully!");
      res.status(200).send(challenge);
    } else {
      console.warn("⚠️ Meta webhook verification failed: verify_token mismatch.");
      res.sendStatus(403);
    }
  });

  // Incoming Meta WhatsApp Messages (POST /webhook)
  app.post("/webhook", async (req: Request, res: Response) => {
    // Meta requires an immediate 200 OK acknowledgment
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Ignore delivery status notifications (sent, delivered, read)
    if (!message || message.type !== "text") return;

    const sender = message.from; // e.g. "917080576302"
    const userMessage = message.text?.body?.trim();
    if (!userMessage) return;

    console.log(`\n📩 Incoming WhatsApp from [${sender}]: "${userMessage}"`);

    cleanExpiredSessions();

    const lowerMsg = userMessage.toLowerCase();

    // Reset command
    if (lowerMsg === "/reset" || lowerMsg === "reset") {
      const existing = sessions.get(sender);
      try { existing?.ctx?.mcpClient?.close(); } catch {}
      sessions.delete(sender);
      const resetMsg = "🔄 Your conversation history has been reset! What would you like to eat today?";
      console.log(`📤 Sending reset message to [${sender}]`);
      await sendWhatsAppMessage(sender, resetMsg);
      return;
    }

    // Logout / Disconnect command
    if (lowerMsg === "/logout" || lowerMsg === "logout" || lowerMsg === "/disconnect" || lowerMsg === "disconnect") {
      const existing = sessions.get(sender);
      try { existing?.ctx?.mcpClient?.close(); } catch {}
      sessions.delete(sender);
      await forgetPhoneSwiggyAccessToken(sender);
      const logoutMsg = "👋 *You have been logged out of your Swiggy account.*\n\nSend any message whenever you'd like to connect a new account or start fresh!";
      console.log(`📤 Sending logout message to [${sender}]`);
      await sendWhatsAppMessage(sender, logoutMsg);
      return;
    }

    const accessToken = await getEffectiveSwiggyToken(sender);
    if (!accessToken) {
      if (!OAUTH_PUBLIC_BASE_URL) {
        await sendWhatsAppMessage(sender, "⚠️ Swiggy connection is not configured yet. Please contact the bot owner.");
        return;
      }
      try {
        const connectUrl = await beginPhoneSwiggyAuthorization(sender, `${OAUTH_PUBLIC_BASE_URL}${OAUTH_CALLBACK_PATH}`);
        const welcomeMsg =
`👋 *Welcome to Swiggy AI!* 🍔

To view your delivery addresses, access your cart, and place orders, please connect your Swiggy account:

👉 *Connect Swiggy:* ${connectUrl}

🔒 _Secure phone + OTP login on Swiggy's official portal. Valid for 5 days._
After connecting, return right here and tell me what you'd like to eat!`;
        await sendWhatsAppMessage(sender, welcomeMsg);
      } catch (err: any) {
        console.error("Could not start Swiggy OAuth:", err?.message ?? err);
        await sendWhatsAppMessage(sender, "⚠️ I could not generate your Swiggy connection link. Please try again shortly.");
      }
      return;
    }

    // Create one MCP connection per authorized WhatsApp user.
    let session = sessions.get(sender);
    if (!session) {
      try {
        session = { history: [], lastActive: Date.now(), ctx: await initAgentContext(accessToken) };
      } catch (err: any) {
        console.error("Could not initialize Swiggy session:", err?.message ?? err);
        await sendWhatsAppMessage(sender, "I could not connect to your Swiggy account. Please reconnect and try again.");
        return;
      }
      sessions.set(sender, session);
    }
    session.lastActive = Date.now();

    // Process turn asynchronously
    try {
      console.log(`🤖 Processing request for [${sender}]...`);
      const reply = await runAgentTurn(
        session.ctx,
        session.history,
        userMessage,
        (tools) => {
          console.log(`  🔧 Tools called for [${sender}]: ${tools.join(", ")}`);
        }
      );

      console.log(`📤 Sending reply to [${sender}] (${reply.length} chars)`);
      await sendWhatsAppMessage(sender, reply);
    } catch (err: any) {
      console.error(`❌ Error handling message for [${sender}]:`, err?.message ?? err);
      if (String(err?.message ?? err).includes("401")) {
        const existing = sessions.get(sender);
        try { existing?.ctx?.mcpClient?.close(); } catch {}
        sessions.delete(sender);
        forgetPhoneSwiggyAccessToken(sender);
      }
      const fallbackMsg = "⚠️ Sorry, I encountered an issue checking Swiggy meals. Please try again in a moment or send /reset to start fresh.";
      await sendWhatsAppMessage(sender, fallbackMsg);
    }
  });

  app.listen(PORT, async () => {
    console.log(`🚀 Meta WhatsApp server running on http://localhost:${PORT}`);
    console.log(`👉 Webhook URL for Meta: https://<your-ngrok-url>.ngrok-free.app/webhook`);
    console.log(`👉 Verify Token for Meta: ${META_VERIFY_TOKEN}`);
    if (!isMetaConfigured) {
      console.log("\n⚠️  META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID not set in .env.");
      console.log("   The server is running in dev simulation mode (replies will print to console).");
      console.log("   Add your Meta credentials to .env to enable live WhatsApp delivery.\n");
    } else {
      const tokenStatus = await checkMetaTokenStatus();
      if (tokenStatus.valid) {
        console.log(`✓ Meta credentials verified: ${tokenStatus.message}`);
      } else {
        console.warn(`⚠️ Meta Access Token warning: ${tokenStatus.message}`);
        console.warn("👉 Please generate a fresh token at https://developers.facebook.com and update META_WHATSAPP_TOKEN.");
      }
      console.log("✓ Meta WhatsApp dispatching enabled.\n");
    }
  });
}

startServer().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
