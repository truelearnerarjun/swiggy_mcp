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
  search_restaurants: "Search for restaurants by query or dietary filter near a delivery address.",
  search_menu: "Search for dishes and menu items across restaurants or within a specific restaurant.",
  get_restaurant_menu: "Get the full menu, categories, and prices for a specific restaurant by restaurantId.",
  get_food_cart: "Get the user's current food delivery cart, items, prices, and totals.",
  update_food_cart: "Add, update, or remove items in the food delivery cart for a restaurantId.",
  flush_food_cart: "Clear and empty the current food delivery cart.",
  fetch_food_coupons: "Fetch available coupons and promotional offers for the current food cart.",
  apply_food_coupon: "Apply a coupon code to the current food cart.",
  place_food_order: "Place a food delivery order (only with explicit user confirmation; paymentMethod COD).",
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
      entry.items = { type: itemType };
    }

    properties[propName] = entry;
  }

  const result: any = { type: "object", properties };
  if (Array.isArray(inputSchema.required) && inputSchema.required.length > 0) {
    result.required = inputSchema.required;
  }
  return result;
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
        try {
          const mcpResult = await ctx.mcpClient.callTool({
            name: toolName,
            arguments: (call.args ?? {}) as Record<string, unknown>,
          });

          const content = (mcpResult as any).content;
          const resultText = Array.isArray(content)
            ? content
                .map((p: any) => (p.type === "text" ? (p.text ?? "") : JSON.stringify(p)))
                .join("\n")
            : JSON.stringify(mcpResult);

          if (debug) {
            console.error(`\n[DEBUG] Tool ${toolName} result:`, resultText.slice(0, 300));
          }

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
