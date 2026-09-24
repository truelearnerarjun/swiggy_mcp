/**
 * AI Nutrition Agent — Twilio WhatsApp Bot Server
 *
 * Exposes an Express webhook for Twilio WhatsApp integration.
 * Manages user sessions by phone number and dispatches replies
 * asynchronously via the Twilio REST API to avoid 15s webhook timeouts.
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import twilio from "twilio";
import { initAgentContext, runAgentTurn, AgentContext } from "./agent-core.js";
import {
  beginPhoneSwiggyAuthorization,
  completePhoneSwiggyAuthorization,
  getPhoneSwiggyAccessToken,
  getEffectiveSwiggyToken,
  forgetPhoneSwiggyAccessToken,
} from "./swiggy-oauth.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER =
  process.env.TWILIO_WHATSAPP_NUMBER ?? "whatsapp:+14155238886";

const hasTwilioCredentials = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
const OAUTH_PUBLIC_BASE_URL = (process.env.OAUTH_PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
const OAUTH_CALLBACK_PATH = "/oauth/swiggy/callback";
const twilioClient = hasTwilioCredentials
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

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

async function startServer() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  📱 AI Nutrition Agent — Twilio WhatsApp Bot     ");
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
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Health check
  app.get(["/", "/healthz"], (_req: Request, res: Response) => {
    res.json({
      status: "online",
      agent: "Swiggy AI Nutrition Bot",
      twilioConfigured: hasTwilioCredentials,
      activeSessions: sessions.size,
    });
  });

  app.get(OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    try {
      const { phoneNumber } = await completePhoneSwiggyAuthorization({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      });
      sessions.delete(phoneNumber);
      res.type("html").send("<h2>Swiggy connected</h2><p>Return to WhatsApp to continue.</p>");
      await sendReply(phoneNumber, "Your Swiggy account is connected. Tell me what you would like to eat.");
    } catch (err: any) {
      res.status(400).type("html").send("<h2>Could not connect Swiggy</h2><p>Return to WhatsApp and request a new connect link.</p>");
      console.warn("Swiggy OAuth callback failed:", err?.message ?? err);
    }
  });

  // Twilio Webhook
  app.post("/webhook", async (req: Request, res: Response) => {
    const sender = (req.body.From ?? req.body.from ?? "").trim();
    const userMessage = (req.body.Body ?? req.body.body ?? req.body.message ?? "").trim();

    if (!sender || !userMessage) {
      res.status(200).send("<Response/>");
      return;
    }

    console.log(`\n📩 Incoming WhatsApp from [${sender}]: "${userMessage}"`);

    // Acknowledge webhook immediately with empty TwiML to satisfy Twilio's 15s timeout
    res.type("text/xml").status(200).send("<Response/>");

    cleanExpiredSessions();

    // Reset session command
    if (userMessage.toLowerCase() === "/reset" || userMessage.toLowerCase() === "reset") {
      const existing = sessions.get(sender);
      try { existing?.ctx?.mcpClient?.close(); } catch {}
      sessions.delete(sender);
      const resetMsg = "🔄 Your conversation history has been reset! What would you like to eat today?";
      console.log(`📤 Sending reset message to [${sender}]`);
      await sendReply(sender, resetMsg);
      return;
    }

    const accessToken = await getEffectiveSwiggyToken(sender);
    if (!accessToken) {
      if (!OAUTH_PUBLIC_BASE_URL) {
        await sendReply(sender, "Swiggy connection is not configured yet. Please contact the bot owner.");
        return;
      }
      try {
        const connectUrl = await beginPhoneSwiggyAuthorization(sender, `${OAUTH_PUBLIC_BASE_URL}${OAUTH_CALLBACK_PATH}`);
        await sendReply(sender, `Welcome to Swiggy AI. Connect your own Swiggy account to access your addresses and cart:\n${connectUrl}\n\nAfter you finish, return here and tell me what you would like to eat.`);
      } catch (err: any) {
        console.error("Could not start Swiggy OAuth:", err?.message ?? err);
        await sendReply(sender, "I could not start Swiggy connection. Please try again shortly.");
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
        await sendReply(sender, "I could not connect to your Swiggy account. Please reconnect and try again.");
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
      await sendReply(sender, reply);
    } catch (err: any) {
      console.error(`❌  Error handling message for [${sender}]:`, err?.message ?? err);
      if (String(err?.message ?? err).includes("401")) {
        const existing = sessions.get(sender);
        try { existing?.ctx?.mcpClient?.close(); } catch {}
        sessions.delete(sender);
        forgetPhoneSwiggyAccessToken(sender);
      }
      const fallbackMsg = "⚠️ Sorry, I encountered an issue checking Swiggy meals. Please try again in a moment or send /reset to start fresh.";
      await sendReply(sender, fallbackMsg);
    }
  });

  // Helper to send message via Twilio or console fallback
  async function sendReply(to: string, body: string) {
    if (twilioClient) {
      try {
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_NUMBER,
          to,
          body,
        });
        console.log(`✓ Delivered WhatsApp reply to ${to}`);
      } catch (sendErr: any) {
        console.error(`❌  Failed to send Twilio message:`, sendErr?.message ?? sendErr);
      }
    } else {
      console.log(`\n[DEV MODE - TWILIO NOT CONFIGURED] Reply for ${to}:\n${body}\n`);
    }
  }

  app.listen(PORT, () => {
    console.log(`🚀 WhatsApp server running on http://localhost:${PORT}`);
    console.log(`👉 Webhook endpoint: http://localhost:${PORT}/webhook`);
    if (!hasTwilioCredentials) {
      console.log("\n⚠️  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env.");
      console.log("   The server is running in dev simulation mode (replies will print to console).");
      console.log("   Add your Twilio credentials to .env to enable live WhatsApp delivery.\n");
    } else {
      console.log("✓ Twilio credentials detected. Live WhatsApp dispatching enabled.\n");
    }
  });
}

startServer().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
