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

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN?.trim().replace(/^["']|["']$/g, "");
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID?.trim().replace(/^["']|["']$/g, "");
const META_VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN ?? "swiggy_agent_secret").trim().replace(/^["']|["']$/g, "");

const isMetaConfigured = Boolean(META_WHATSAPP_TOKEN && META_PHONE_NUMBER_ID);

// Multi-turn conversation memory keyed by sender phone number
interface UserSession {
  history: any[];
  lastActive: number;
}
const sessions = new Map<string, UserSession>();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [phone, sess] of sessions.entries()) {
    if (now - sess.lastActive > SESSION_TTL_MS) {
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

    // Reset command
    if (userMessage.toLowerCase() === "/reset" || userMessage.toLowerCase() === "reset") {
      sessions.delete(sender);
      const resetMsg = "🔄 Your conversation history has been reset! What would you like to eat today?";
      console.log(`📤 Sending reset message to [${sender}]`);
      await sendWhatsAppMessage(sender, resetMsg);
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
      await sendWhatsAppMessage(sender, reply);
    } catch (err: any) {
      console.error(`❌ Error handling message for [${sender}]:`, err?.message ?? err);
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
