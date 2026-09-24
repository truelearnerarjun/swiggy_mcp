/**
 * AI Nutrition Agent — Core Engine
 *
 * Encapsulates the Swiggy Food MCP connection, tool discovery,
 * Gemini API interaction, and multi-round function calling loop.
 * Shared between the terminal CLI (index.ts) and WhatsApp server.
 */

import "dotenv/config";
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSwiggyAuthHeaders } from "./swiggy-oauth.js";
import { buildAgentInstructions } from "./agent-instructions.js";
import { userProfile, type UserProfile } from "./user-profile.js";

export const SWIGGY_FOOD_URL =
  process.env.SWIGGY_MCP_FOOD_URL ?? "https://mcp.swiggy.com/food";

export const GEMINI_MODEL = "gemini-2.5-flash";

// ─── Schema helpers ───────────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS: Record<string, string> = {
  get_addresses: "Get the user's saved Swiggy delivery addresses.",
  create_address: "Create a new saved delivery address for the user.",
  delete_address: "Delete a saved delivery address by addressId.",
  search_restaurants: "Search for restaurants by cuisine or query near a delivery address (takes addressId, query). Returns restaurant names, ratings (avgRating), and cuisines.",
  search_menu: "Search for specific dishes and food items across restaurants near a delivery address (takes addressId, query, vegFilter). Returns dish names, prices, restaurant ratings (e.g. 4.4★), and restaurant IDs.",
  get_restaurant_menu: "Get the full menu, categories, and prices for a specific restaurant by restaurantId.",
  get_food_cart: "Get the user's current food delivery cart, items, prices, and totals.",
  update_food_cart: "Add, update, or remove items in the food delivery cart for a restaurantId.",
  flush_food_cart: "Clear and empty the current food delivery cart.",
  fetch_food_coupons: "Fetch available coupons and promotional offers for the current food cart.",
  apply_food_coupon: "Apply a coupon code to the current food cart.",
  get_payment_options: "Fetch available payment options for the current food cart (e.g. UPI, Cash).",
  place_food_order: "Place a food delivery order with paymentMethod 'UPI' or 'Cash' (only with explicit user confirmation). For UPI, returns a payment link/QR; for Cash, places a Cash on Delivery order.",
  check_payment_status: "Check status of an in-flight UPI payment using paasId.",
  confirm_order: "Confirm a food order after UPI payment succeeds.",
  track_food_order: "Track status and delivery ETA for an active food order.",
  get_food_orders: "Get user's past and active food delivery orders history.",
  get_food_order_details: "Get full details of a specific food delivery order by orderId.",
};

export function cleanDescription(toolName: string, rawDesc: string): string {
  if (TOOL_DESCRIPTIONS[toolName]) return TOOL_DESCRIPTIONS[toolName];
  if (!rawDesc) return "";
  let cleaned = rawDesc.replace(/\[STAGING GUEST FLOW\][^.]*\.\s*/gi, "");
  cleaned = cleaned.replace(/📍 WORKFLOW[\s\S]*?(?=(\n\n|$))/gi, "").trim();
  const match = cleaned.match(/^([^.!?]+[.!?])/);
  if (match && match[0].length >= 15 && match[0].length <= 250) {
    return match[0].trim();
  }
  return cleaned.slice(0, 200).trim();
}

function resolveType(schema: any): string {
  if (!schema) return "string";
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t: string) => t !== "null");
    return nonNull[0] ?? "string";
  }
  if (typeof schema.type === "string") return schema.type;
  if (schema.anyOf || schema.oneOf) {
    const variants: any[] = schema.anyOf ?? schema.oneOf;
    const nonNull = variants.filter((s: any) => s?.type !== "null");
    return nonNull[0]?.type ?? "string";
  }
  if (schema.enum) return "string";
  return "string";
}

export function buildMinimalSchema(inputSchema: any): any {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} };
  }

  const properties: Record<string, any> = {};
  const raw = inputSchema.properties ?? {};

  for (const [propName, propSchema] of Object.entries(raw as Record<string, any>)) {
    const type = resolveType(propSchema);
    const entry: any = { type, description: (propSchema.description ?? "").slice(0, 100) };

    if (propSchema.enum) {
      entry.enum = (propSchema.enum as unknown[]).map(String);
    }

    if (type === "array" && propSchema.items) {
      const itemType = resolveType(propSchema.items);
      if (itemType === "object" && propSchema.items.properties) {
        entry.items = buildMinimalSchema(propSchema.items);
      } else {
        entry.items = { type: itemType };
      }
    }

    properties[propName] = entry;
  }

  const result: any = { type: "object", properties };
  if (Array.isArray(inputSchema.required) && inputSchema.required.length > 0) {
    result.required = inputSchema.required;
  }
  return result;
}

// ─── Address Caching & Resolution ─────────────────────────────────────────────

export interface CachedAddress {
  index: number;
  label: string;
  address: string;
  id: string;
}


export interface ActiveOrderPaymentContext {
  orderId: string;
  paasId: string;
  addressId: string;
  cartId?: string | number;
  lat?: number;
  lng?: number;
  bridgeUrl?: string;
  upiIntentUrl?: string;
  qrImageUrl?: string;
  totalAmount?: number;
  status?: string;
}

function cacheAddressesFromText(ctx: AgentContext, text: string) {
  if (!text) return;
  // Parse lines like: "1. [Office] Arjun Tandon: ... (ID: dajbcpk...)"
  const lineRegex = /(\d+)\.\s*\[(.*?)\]\s*(.*?)\s*\(ID:\s*([^\)]+)\)/g;
  let match;
  while ((match = lineRegex.exec(text)) !== null) {
    const index = parseInt(match[1], 10);
    const label = match[2].trim();
    const address = match[3].trim();
    const id = match[4].trim();
    const existing = ctx.cachedAddresses.find((a) => a.id === id);
    if (!existing) {
      ctx.cachedAddresses.push({ index, label, address, id });
    }
  }

  try {
    const parsed = JSON.parse(text);
    const list = parsed.data || parsed.addresses || (Array.isArray(parsed) ? parsed : null);
    if (Array.isArray(list)) {
      list.forEach((item: any, idx: number) => {
        const id = item.id || item.addressId;
        if (id && !ctx.cachedAddresses.find((a) => a.id === id)) {
          ctx.cachedAddresses.push({
            index: idx + 1,
            label: item.label || item.addressLabel || "",
            address: item.formattedAddress || item.address || "",
            id,
          });
        }
      });
    }
  } catch {
    // not JSON
  }
}

function resolveAddressId(ctx: AgentContext, input: unknown): string {
  if (!input) return ctx.lastSelectedAddressId || ctx.cachedAddresses[0]?.id || "";
  const str = String(input).trim();
  const num = parseInt(str, 10);
  if (!isNaN(num) && num >= 1 && num <= ctx.cachedAddresses.length) {
    const found = ctx.cachedAddresses[num - 1];
    if (found) {
      ctx.lastSelectedAddressId = found.id;
      return found.id;
    }
  }
  const byLabel = ctx.cachedAddresses.find(
    (a) => a.label.toLowerCase() === str.toLowerCase()
  );
  if (byLabel) {
    ctx.lastSelectedAddressId = byLabel.id;
    return byLabel.id;
  }
  const byId = ctx.cachedAddresses.find((a) => a.id === str);
  if (byId) {
    ctx.lastSelectedAddressId = byId.id;
    return byId.id;
  }
  ctx.lastSelectedAddressId = str;
  return str;
}

// ─── Agent Context ────────────────────────────────────────────────────────────

export interface AgentContext {
  ai: GoogleGenAI;
  mcpClient: Client;
  functionDeclarations: any[];
  systemInstruction: string;
  userProfile: UserProfile;
  cachedAddresses: CachedAddress[];
  lastSelectedAddressId: string | null;
  lastPaymentContext: ActiveOrderPaymentContext | null;
}

/**
 * Initializes Swiggy MCP connection, discovers tools, and prepares the Gemini model.
 */
export async function initAgentContext(accessToken?: string): Promise<AgentContext> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env: GEMINI_API_KEY=AIza..."
    );
  }

  const authHeaders = await getSwiggyAuthHeaders(accessToken);

  const mcpClient = new Client({ name: "nutrition-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(SWIGGY_FOOD_URL),
    { requestInit: { headers: authHeaders } }
  );

  await mcpClient.connect(transport);

  const { tools: mcpTools } = await mcpClient.listTools();

  const functionDeclarations = mcpTools.map((tool) => ({
    name: tool.name,
    description: cleanDescription(tool.name, tool.description ?? ""),
    parameters: buildMinimalSchema(tool.inputSchema as any),
  }));

  const contextState = {
    cachedAddresses: [] as CachedAddress[],
    lastSelectedAddressId: null as string | null,
    lastPaymentContext: null as ActiveOrderPaymentContext | null,
  };
  const cachedAddresses = contextState.cachedAddresses;

  // Pre-warm the address cache for this authenticated Swiggy user only.
  try {
    const addrResult = await mcpClient.callTool({ name: "get_addresses" });
    const text = (addrResult as any).content?.[0]?.text;
    if (text) {
      cacheAddressesFromText(contextState as AgentContext, text);
      if (contextState.cachedAddresses.length > 0) {
        contextState.lastSelectedAddressId = contextState.cachedAddresses[0].id;
        console.log(
          `✓ Pre-cached ${cachedAddresses.length} Swiggy address(es). Default: [${cachedAddresses[0].label}] (${cachedAddresses[0].id})`
        );
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Could not pre-cache addresses on init:", err?.message ?? err);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const systemInstruction = buildAgentInstructions(userProfile);

  return {
    ai,
    mcpClient,
    functionDeclarations,
    systemInstruction,
    userProfile,
    ...contextState,
  };
}

// ─── Run Agent Turn ───────────────────────────────────────────────────────────

export async function runAgentTurn(
  ctx: AgentContext,
  history: any[],
  userMessage: string,
  onToolCall?: (toolNames: string[]) => void
): Promise<string> {
  history.push({ role: "user", parts: [{ text: userMessage }] });

  for (let round = 0; round < 10; round++) {
    const response = await ctx.ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: history,
      config: {
        systemInstruction: ctx.systemInstruction,
        tools: [{ functionDeclarations: ctx.functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      },
    });

    const candidate = response.candidates?.[0];
    const rawParts = candidate?.content?.parts ?? [];
    const debug = process.env.DEBUG_AGENT === "1";

    if (debug) {
      console.error("\n[DEBUG] response parts:", JSON.stringify(rawParts, null, 2));
    }

    const extractText = (): string | undefined => {
      try {
        const t = response.text;
        if (t && t.trim().length > 0) return t;
      } catch { /* fallthrough */ }

      if (!rawParts || rawParts.length === 0) return undefined;
      const texts = rawParts
        .filter((p: any) => typeof p.text === "string" && p.text.trim().length > 0)
        .map((p: any) => p.text as string);
      return texts.length > 0 ? texts.join("") : undefined;
    };

    const extractFunctionCalls = (): any[] => {
      try {
        const fc = response.functionCalls;
        if (Array.isArray(fc) && fc.length > 0) return fc;
      } catch { /* fallthrough */ }

      return rawParts.filter((p: any) => p.functionCall != null).map((p: any) => p.functionCall);
    };

    if (candidate?.content?.parts && candidate.content.parts.length > 0) {
      history.push({ role: "model", parts: candidate.content.parts });
    }

    const functionCalls = extractFunctionCalls();

    if (functionCalls.length === 0) {
      const text = extractText();
      if (text) return text;

      const finishReason = candidate?.finishReason ?? "unknown";
      if (debug) {
        console.error("[DEBUG] finish reason:", finishReason, "| full response:", JSON.stringify(response, null, 2));
      }
      return `(Model returned an empty response. Finish reason: ${finishReason}.)`;
    }

    const callNames = functionCalls.map((c: any) => c.name);
    if (onToolCall) {
      onToolCall(callNames);
    }

    const toolResultParts = await Promise.all(
      functionCalls.map(async (call: any) => {
        const toolName = call.name ?? call.id ?? "unknown_tool";
        const args = { ...(call.args ?? {}) } as Record<string, any>;

        // Intercept and normalize arguments before dispatching to Swiggy MCP
        if (toolName === "update_food_cart") {
          // 1. If agent passed 'items' instead of 'cartItems'
          if (args.items && !args.cartItems) {
            args.cartItems = args.items;
            delete args.items;
          }
          // 2. If cartItems is a single object rather than array
          if (args.cartItems && !Array.isArray(args.cartItems)) {
            args.cartItems = [args.cartItems];
          }
          // 3. Normalize each cart item to { menu_item_id, quantity, ... }
          if (Array.isArray(args.cartItems)) {
            args.cartItems = args.cartItems.map((item: any) => {
              const menuItemId =
                item.menu_item_id ||
                item.menuItemId ||
                item.itemId ||
                item.item_id ||
                item.id ||
                item.dishId;
              const quantity =
                typeof item.quantity === "number"
                  ? item.quantity
                  : Number(item.quantity) || 1;
              const cleanItem: any = {
                menu_item_id: String(menuItemId),
                quantity,
              };
              if (item.variants) cleanItem.variants = item.variants;
              if (item.variantsV2) cleanItem.variantsV2 = item.variantsV2;
              if (item.addons) cleanItem.addons = item.addons;
              return cleanItem;
            });
          }
          // 4. Restaurant ID normalization
          if (!args.restaurantId && args.restaurant_id) {
            args.restaurantId = args.restaurant_id;
          }
        }

        // place_food_order normalization: auto-configure UPI intentApp or QR
        if (toolName === "place_food_order") {
          const pm = String(args.paymentMethod || "").trim().toUpperCase();
          if (pm === "UPI" || pm === "ONLINE" || (!pm && !args.cod)) {
            args.paymentMethod = "UPI";
            const app = typeof args.intentApp === "string" ? args.intentApp.toLowerCase() : "";
            if (app.includes("gpay") || app.includes("google")) {
              args.intentApp = "gpay://upi/";
              delete args.generateUPIQR;
            } else if (app.includes("phonepe") || app.includes("phone")) {
              args.intentApp = "phonepe://";
              delete args.generateUPIQR;
            } else if (app.includes("paytm")) {
              args.intentApp = "paytmmp://";
              delete args.generateUPIQR;
            } else if (app.includes("bhim")) {
              args.intentApp = "bhim://upi/";
              delete args.generateUPIQR;
            } else if (app.includes("cred")) {
              args.intentApp = "credpay://upi/";
              delete args.generateUPIQR;
            } else if (app.includes("super")) {
              args.intentApp = "super://";
              delete args.generateUPIQR;
            } else if (app.includes("fam") || app.includes("fpupi")) {
              args.intentApp = "fpupi://";
              delete args.generateUPIQR;
            } else {
              // Universal UPI & QR: provides universal QR code + standard upi://pay button
              // compatible with ALL UPI apps (Google Pay, PhonePe, Paytm, BHIM, CRED)
              args.generateUPIQR = true;
              delete args.intentApp;
            }
          } else if (pm === "CASH" || pm === "COD") {
            args.paymentMethod = "Cash";
            delete args.intentApp;
            delete args.generateUPIQR;
          } else if (pm === "SWIGGYPAY" || pm.includes("SWIGGY")) {
            args.paymentMethod = "SwiggyPay";
            delete args.intentApp;
            delete args.generateUPIQR;
          }
        }

        // check_payment_status normalization: auto-populate paasId and identifiers from context
        if (toolName === "check_payment_status") {
          const invalidPaas = !args.paasId || args.paasId === "UPI" || args.paasId === "PayWithQR";
          if (invalidPaas && ctx.lastPaymentContext?.paasId) {
            args.paasId = ctx.lastPaymentContext.paasId;
          }
          if (!args.orderId && ctx.lastPaymentContext?.orderId) {
            args.orderId = ctx.lastPaymentContext.orderId;
          }
          if (!args.addressId && ctx.lastPaymentContext?.addressId) {
            args.addressId = ctx.lastPaymentContext.addressId;
          }
          if (args.lat === undefined && ctx.lastPaymentContext?.lat !== undefined) {
            args.lat = ctx.lastPaymentContext.lat;
          }
          if (args.lng === undefined && ctx.lastPaymentContext?.lng !== undefined) {
            args.lng = ctx.lastPaymentContext.lng;
          }
        }

        // confirm_order normalization: auto-populate orderId and coordinates
        if (toolName === "confirm_order") {
          if (!args.orderId && ctx.lastPaymentContext?.orderId) {
            args.orderId = ctx.lastPaymentContext.orderId;
          }
          if (!args.addressId && ctx.lastPaymentContext?.addressId) {
            args.addressId = ctx.lastPaymentContext.addressId;
          }
          if (args.lat === undefined && ctx.lastPaymentContext?.lat !== undefined) {
            args.lat = ctx.lastPaymentContext.lat;
          }
          if (args.lng === undefined && ctx.lastPaymentContext?.lng !== undefined) {
            args.lng = ctx.lastPaymentContext.lng;
          }
          if (!args.cartId && ctx.lastPaymentContext?.cartId) {
            args.cartId = ctx.lastPaymentContext.cartId;
          }
        }

        // apply_food_coupon normalization: map code -> couponCode
        if (toolName === "apply_food_coupon") {
          if (args.code && !args.couponCode) {
            args.couponCode = args.code;
          }
        }

        // Universal Address ID resolution across all tools
        if ("addressId" in args || args.addressId !== undefined) {
          args.addressId = resolveAddressId(ctx, args.addressId);
        } else if (
          ctx.lastSelectedAddressId &&
          [
            "update_food_cart",
            "get_food_cart",
            "search_menu",
            "search_restaurants",
            "place_food_order",
            "get_payment_options",
            "get_restaurant_menu",
            "fetch_food_coupons",
            "apply_food_coupon",
          ].includes(toolName)
        ) {
          args.addressId = ctx.lastSelectedAddressId;
        }

        console.log(`[TOOL CALL] ${toolName} with args:`, JSON.stringify(args));

        try {
          const mcpResult = await ctx.mcpClient.callTool({
            name: toolName,
            arguments: args,
          });

          const content = (mcpResult as any).content;
          let resultText = Array.isArray(content)
            ? content
                .map((p: any) => (p.type === "text" ? (p.text ?? "") : JSON.stringify(p)))
                .join("\n")
            : JSON.stringify(mcpResult);

          const structured = (mcpResult as any).structuredContent;
          if (structured) {
            resultText += "\n\nStructured Data:\n" + JSON.stringify(structured, null, 2);
          }

          if (toolName === "place_food_order") {
            const paymentData = structured?.data ?? structured ?? {};
            const upiIntent =
              paymentData.upiIntentUrl ||
              (mcpResult as any)._meta?.upiIntentUrl;
            const bridgeUrl = paymentData.bridgeUrl || (mcpResult as any)._meta?.bridgeUrl;
            const orderId = paymentData.orderId;
            const paasId = paymentData.paasId || paymentData.transactionId;
            const totalAmount = paymentData.totalAmount || paymentData.paidAmount;

            let universalUpiUrl = "";
            if (upiIntent && typeof upiIntent === "string") {
              universalUpiUrl = upiIntent.replace(/^(phonepe|gpay|paytmmp|bhim|credpay):\/\/(upi\/)?pay\?/i, "upi://pay?");
              if (!universalUpiUrl.startsWith("upi://")) {
                const queryPart = upiIntent.split("?")[1];
                if (queryPart) universalUpiUrl = `upi://pay?${queryPart}`;
              }
            } else if (bridgeUrl && typeof bridgeUrl === "string") {
              try {
                const parsed = new URL(bridgeUrl);
                const linkParam = parsed.searchParams.get("link");
                if (linkParam) {
                  const decoded = decodeURIComponent(linkParam);
                  universalUpiUrl = decoded.replace(/^(phonepe|gpay|paytmmp|bhim|credpay):\/\/(upi\/)?pay\?/i, "upi://pay?");
                  if (!universalUpiUrl.startsWith("upi://")) {
                    const queryPart = decoded.split("?")[1];
                    if (queryPart) universalUpiUrl = `upi://pay?${queryPart}`;
                  }
                }
              } catch {}
            }

            const qrTarget = universalUpiUrl || bridgeUrl || "";
            const qrImageUrl = qrTarget
              ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qrTarget)}`
              : "";

            if (orderId && paasId) {
              ctx.lastPaymentContext = {
                orderId: String(orderId),
                paasId: String(paasId),
                addressId: paymentData.addressId || args.addressId,
                cartId: paymentData.cartId,
                lat: paymentData.lat,
                lng: paymentData.lng,
                bridgeUrl,
                upiIntentUrl: universalUpiUrl || upiIntent,
                qrImageUrl,
                totalAmount: totalAmount ? Number(totalAmount) : undefined,
                status: paymentData.status,
              };
            }

            resultText += `\n\n[PAYMENT GATEWAY - CRITICAL INSTRUCTIONS]
- Order ID: ${orderId ?? "Pending"}
- Status: ${paymentData.status ?? "PENDING_PAYMENT"}
- Total Payable: ₹${totalAmount ?? ""}
- Swiggy Official Payment Link: ${bridgeUrl ?? "N/A"}
- Universal UPI QR Code Image: ${qrImageUrl || "N/A"}
- UPI Intent String: ${universalUpiUrl || upiIntent || "N/A"}

IMPORTANT FOR WHATSAPP/CHAT RESPONSE:
You are chatting with the user in WhatsApp/chat. There is NO web browser widget on their screen!
You MUST present:
1. 📱 **Mobile (Tap to Pay):**
   ${bridgeUrl ? `🔗 Tap to open UPI App: ${bridgeUrl}` : ""}
2. 📷 **Scan QR Code (Desktop or Any Phone):**
   ${qrImageUrl ? `📷 Scan QR Code Image: ${qrImageUrl}` : ""}
   (Works with Google Pay, PhonePe, Paytm, CRED, BHIM)
3. 🛍️ **Swiggy Mobile App Checkout:**
   "Your cart is also synced directly to your Swiggy account! You can simply open the Swiggy mobile app on your phone, go to Cart, and complete payment with UPI, Card, NetBanking, or Swiggy Money."
4. ⏱️ **Expiry Warning:**
   "Note: UPI payment links expire in 60 seconds. If the link expires, you can either complete checkout in the Swiggy mobile app or reply here to regenerate a new payment link."
5. 🔄 **Confirmation:**
   "Once you've completed payment, reply 'Paid' or 'Confirm payment' so I can verify and confirm your order!"

DO NOT say "the QR code is on your screen in a widget" or that you cannot provide a link.`;
          }

          if (toolName === "get_addresses") {
            cacheAddressesFromText(ctx, resultText);
          }

          console.log(`[TOOL RESULT] ${toolName}:`, resultText.slice(0, 300));

          return {
            functionResponse: {
              name: toolName,
              response: { result: resultText },
            },
          };
        } catch (toolErr: any) {
          const errMsg = toolErr?.message ?? String(toolErr);
          console.error(`\n  ⚠️  Tool ${toolName} failed: ${errMsg}`);
          return {
            functionResponse: {
              name: toolName,
              response: { error: errMsg },
            },
          };
        }
      })
    );

    history.push({ role: "user", parts: toolResultParts });
  }

  return "(Agent reached maximum tool-call rounds — please try again.)";
}
