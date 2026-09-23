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

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER =
  process.env.TWILIO_WHATSAPP_NUMBER ?? "whatsapp:+14155238886";

const hasTwilioCredentials = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
const twilioClient = hasTwilioCredentials
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Multi-turn conversation memory keyed by sender phone number
interface UserSession {
  history: any[];
  lastActive: number;
}
const sessions = new Map<string, UserSession>();

// Clear sessions older than 24 hours to keep memory tidy
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [phone, sess] of sessions.entries()) {
    if (now - sess.lastActive > SESSION_TTL_MS) {
      sessions.delete(phone);
    }
  }
}

async function startServer() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  📱 AI Nutrition Agent — Twilio WhatsApp Bot     ");
  console.log("═══════════════════════════════════════════════════\n");

  let ctx: AgentContext;
  try {
    console.log("🔗 Connecting to Swiggy Food MCP & Gemini...");
    ctx = await initAgentContext();
    console.log("✓ Connected to Swiggy Food MCP.\n");
  } catch (err: any) {
    console.error("❌  Initialization failed:", err?.message ?? err);
    process.exit(1);
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
      sessions.delete(sender);
      const resetMsg = "🔄 Your conversation history has been reset! What would you like to eat today?";
      console.log(`📤 Sending reset message to [${sender}]`);
      await sendReply(sender, resetMsg);
      return;
    }

    // Get or initialize session history
    let session = sessions.get(sender);
    if (!session) {
      session = { history: [], lastActive: Date.now() };
      sessions.set(sender, session);
    }
    session.lastActive = Date.now();

    // Process turn asynchronously
    try {
      console.log(`🤖 Processing request for [${sender}]...`);
      const reply = await runAgentTurn(
        ctx,
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
