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

export const cachedAddresses: CachedAddress[] = [];
export let lastSelectedAddressId: string | null = null;

export function setLastSelectedAddressId(id: string) {
  lastSelectedAddressId = id;
}

export function cacheAddressesFromText(text: string) {
  if (!text) return;
  // Parse lines like: "1. [Office] Arjun Tandon: ... (ID: dajbcpk...)"
  const lineRegex = /(\d+)\.\s*\[(.*?)\]\s*(.*?)\s*\(ID:\s*([^\)]+)\)/g;
  let match;
  while ((match = lineRegex.exec(text)) !== null) {
    const index = parseInt(match[1], 10);
    const label = match[2].trim();
    const address = match[3].trim();
    const id = match[4].trim();
    const existing = cachedAddresses.find((a) => a.id === id);
    if (!existing) {
      cachedAddresses.push({ index, label, address, id });
    }
  }

  try {
    const parsed = JSON.parse(text);
    const list = parsed.data || parsed.addresses || (Array.isArray(parsed) ? parsed : null);
    if (Array.isArray(list)) {
      list.forEach((item: any, idx: number) => {
        const id = item.id || item.addressId;
        if (id && !cachedAddresses.find((a) => a.id === id)) {
          cachedAddresses.push({
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

export function resolveAddressId(input: any): string {
  if (!input) return lastSelectedAddressId || cachedAddresses[0]?.id || "";
  const str = String(input).trim();
  const num = parseInt(str, 10);
  if (!isNaN(num) && num >= 1 && num <= cachedAddresses.length) {
    const found = cachedAddresses[num - 1];
    if (found) {
      lastSelectedAddressId = found.id;
      return found.id;
    }
  }
  const byLabel = cachedAddresses.find(
    (a) => a.label.toLowerCase() === str.toLowerCase()
  );
  if (byLabel) {
    lastSelectedAddressId = byLabel.id;
    return byLabel.id;
  }
  const byId = cachedAddresses.find((a) => a.id === str);
  if (byId) {
    lastSelectedAddressId = byId.id;
    return byId.id;
  }
  lastSelectedAddressId = str;
  return str;
}

// ─── Agent Context ────────────────────────────────────────────────────────────

export interface AgentContext {
  ai: GoogleGenAI;
  mcpClient: Client;
  functionDeclarations: any[];
  systemInstruction: string;
  userProfile: UserProfile;
}

/**
 * Initializes Swiggy MCP connection, discovers tools, and prepares the Gemini model.
 */
export async function initAgentContext(): Promise<AgentContext> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env: GEMINI_API_KEY=AIza..."
    );
  }

  const authHeaders = await getSwiggyAuthHeaders();

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

  // Pre-warm address cache so numeric index references (e.g. "3", "6") resolve immediately
  try {
    const addrResult = await mcpClient.callTool({ name: "get_addresses" });
    const text = (addrResult as any).content?.[0]?.text;
    if (text) {
      cacheAddressesFromText(text);
      if (cachedAddresses.length > 0) {
        lastSelectedAddressId = cachedAddresses[0].id;
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

        // Universal Address ID resolution across all tools
        if ("addressId" in args || args.addressId !== undefined) {
          args.addressId = resolveAddressId(args.addressId);
        } else if (
          lastSelectedAddressId &&
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
          args.addressId = lastSelectedAddressId;
        }

        console.log(`[TOOL CALL] ${toolName} with args:`, JSON.stringify(args));

        try {
          const mcpResult = await ctx.mcpClient.callTool({
            name: toolName,
            arguments: args,
          });

          const content = (mcpResult as any).content;
          const resultText = Array.isArray(content)
            ? content
                .map((p: any) => (p.type === "text" ? (p.text ?? "") : JSON.stringify(p)))
                .join("\n")
            : JSON.stringify(mcpResult);

          if (toolName === "get_addresses") {
            cacheAddressesFromText(resultText);
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
