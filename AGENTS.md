# AI Nutrition Agent — Project Instructions

> **Read this before writing any code.**
> This file is the source of truth for how this project is built.
> When in doubt: read the official Swiggy documentation first.

---

## Project Goal

Build an AI-powered nutrition and food-ordering agent that helps users
choose meals based on their nutrition goals and uses Swiggy MCP to
discover restaurants, build carts, and eventually place orders.

This product does NOT replace Swiggy.
Swiggy is the commerce and order infrastructure.
This agent is the nutrition intelligence layer on top of it.

---

## Core User Experience

A user should be able to say:

> "I want a high-protein vegetarian dinner under ₹250."

The agent should:

1. Understand the user's nutrition preferences.
2. Retrieve the user's Swiggy addresses via `get_addresses`.
3. Search relevant restaurants via `search_restaurants` (only `OPEN` ones).
4. Examine menus via `get_restaurant_menu` or `search_menu`.
5. Filter meals by: protein, calories (if available), dietary preference,
   allergies, budget (hard cap), and user preferences.
6. Rank and present top 3 recommendations with reasoning.
7. Add the selected meal to the cart when the user approves.
8. Show the confirmed cart contents.
9. Ask for explicit user confirmation before calling `place_food_order`.

**Never place an order without explicit user confirmation.**
The only exception: a deliberately enabled, user-configured autopilot mode
(future scope — do not build in Phase 1).

---

## Swiggy MCP — Verified Endpoints

Source of truth: `https://mcp.swiggy.com/builders/llms-full.txt`
OAuth metadata: `https://mcp.swiggy.com/.well-known/oauth-authorization-server`

### MCP Servers

| Server    | URL                             |
|-----------|----------------------------------|
| Food      | `https://mcp.swiggy.com/food`   |
| Instamart | `https://mcp.swiggy.com/im`     |
| Dineout   | `https://mcp.swiggy.com/dineout`|
| Scenes    | `https://mcp.swiggy.com/scenes` |

One OAuth token works across all four servers.
Carts are per-server. Orders are per-server.

**Phase 1 scope: Food MCP only.**

### Do not:
- Invent tool names, parameters, or endpoints.
- Assume a tool exists without verifying in the official docs.
- Use the Instamart MCP server in Phase 1.

---

## OAuth 2.1 + PKCE — Verified from Official Docs

### Live endpoints (confirmed from `/.well-known/oauth-authorization-server`):

```
issuer:                  https://mcp.swiggy.com/auth
authorization_endpoint:  https://mcp.swiggy.com/auth/authorize
token_endpoint:          https://mcp.swiggy.com/auth/token
registration_endpoint:   https://mcp.swiggy.com/auth/register
code_challenge_methods:  S256 only
scopes_supported:        mcp:tools, mcp:resources, mcp:prompts
```

### The exact PKCE flow:

1. Generate `code_verifier` using `crypto.randomBytes(32).toString("base64url")`
2. Generate `code_challenge` = SHA-256 of `code_verifier`, base64url-encoded
3. Register client via `POST /auth/register` (Dynamic Client Registration)
   — MCP-compatible frameworks do this transparently.
4. Open browser to:
   ```
   https://mcp.swiggy.com/auth/authorize?
     response_type=code&
     client_id=<from-dcr>&
     redirect_uri=http://localhost:3000/callback&
     code_challenge=<challenge>&
     code_challenge_method=S256&
     state=<random-csrf-token>&
     scope=mcp:tools
   ```
5. User logs in with phone + OTP in the browser.
6. Swiggy redirects to `http://localhost:3000/callback?code=...&state=...`
7. Exchange code:
   ```json
   POST /auth/token
   {
     "grant_type": "authorization_code",
     "code": "<code>",
     "code_verifier": "<verifier>",
     "redirect_uri": "http://localhost:3000/callback"
   }
   ```
8. Receive `access_token` (JWT, 5-day lifetime).
9. Use `Authorization: Bearer <token>` on all MCP calls.

### Important v1.0 limitations:
- **No refresh tokens** — re-run the full OAuth flow when the token expires.
- **Token lifetime**: 5 days (`expires_in: 432000`).
- `grant_types_supported` lists `refresh_token` but it is NOT wired in v1.0.
- On 401, always re-run authorization. Never retry with the same expired token.

### What to store:
- `access_token` in memory or OS keychain — never plaintext on disk.
- `expires_at = now() + expires_in`; proactively warn when ≤ 60s remain.

### Never hardcode:
- Access tokens
- Authorization codes
- PKCE verifiers
- Client secrets
- User credentials (phone numbers, OTPs)

### Never expose OAuth credentials to the frontend.
Keep all authentication and Swiggy MCP communication server-side.

---

## Redirect URI

Use `http://localhost:3000/callback` for local development.
Spin up a local Express server to catch the redirect and extract the code.
Shut down the callback server after the code is received.

---

## Phase 1 — Food MCP Tool Flow

Build and test incrementally. Verify each step works before moving to the next.

### The canonical 7-tool Food journey (from official docs):

```
get_addresses
     │
     ▼
search_restaurants ──► get_restaurant_menu
                            │
                            ▼
                       update_food_cart ◄── fetch_food_coupons
                            │                       │
                            ▼                       │
                       get_food_cart ◄── apply_food_coupon
                            │
                            ▼
                       place_food_order
                            │
                            ▼
                       track_food_order
```

### Step-by-step with exact tool names:

**Step 1 — Resolve delivery address**
```ts
const addresses = await client.callTool({ name: "get_addresses" });
// Returns: label, addressId, display text — never raw coordinates
const home = addresses.data.find((a) => a.label === "Home") ?? addresses.data[0];
```
If no saved addresses exist, walk user through `create_address`.

**Step 2 — Find restaurants**
```ts
const restaurants = await client.callTool({
  name: "search_restaurants",
  arguments: { addressId: home.id, query: "vegetarian" },
});
// Only recommend restaurants where availabilityStatus === "OPEN"
```

**Step 3 — Browse menu**
```ts
const menu = await client.callTool({
  name: "get_restaurant_menu",
  arguments: { restaurantId: restaurants.data.restaurants[0].id },
});
// Use search_menu for keyword search within or across restaurants
```

**Step 4 — Build cart**
```ts
await client.callTool({
  name: "update_food_cart",
  arguments: {
    restaurantId: menu.data.restaurantId,
    items: [{ itemId: menu.data.items[0].id, quantity: 1 }],
  },
});
// Cart is tied to ONE restaurant. Changing restaurant flushes the cart.
```

**Step 5 — Confirm and place (Phase 1: stop before this)**
```ts
const cart = await client.callTool({ name: "get_food_cart" });
// Hard cap: ₹1000 total for Builders Club orders
// ALWAYS show cart summary to user and get explicit confirmation before placing
const order = await client.callTool({
  name: "place_food_order",
  arguments: { paymentMethod: "COD" }, // COD only in v1.0
});
// place_food_order is NOT idempotent — do check-then-retry, not blind retry
```

### Phase 1 milestone order:

```
Milestone 1: OAuth → get_addresses ✅
Milestone 2: get_addresses → search_restaurants → menu
Milestone 3: Nutrition profile → AI meal scoring → recommendation
Milestone 4: AI selection → cart → user confirmation
Milestone 5: Checkout → order (after Swiggy production approval)
```

---

## Cart Rules (from Official Docs)

- **Always call `get_food_cart` before any cart mutation or `place_food_order`.**
  The authoritative state is server-side. Never cache it.
- One cart per restaurant. Switching restaurant flushes the cart silently —
  warn the user before this happens.
- Cart TTL exists. On `CART_EXPIRED`, rebuild and reconfirm.
- ₹1000 hard cart cap for Builders Club origin orders.
- Items may go out of stock, prices may change, coupons may expire between turns.

---

## Rate Limits (from Official Docs)

| Scope                               | Limit            |
|-------------------------------------|------------------|
| Per user, per server                | 70 req/min       |
| Per user, per server (write tools)  | 30 req/min       |
| Burst (10-second window)            | 2× steady-state  |

**Connection hygiene (critical):**
- One session per user, not one per request.
- Never reconnect per tool call — each reconnect counts toward rate limits.
- Initialize MCP servers sequentially, not in parallel.
- Never create a new initialize handshake per tool invocation.
- Do not poll `track_*` faster than every 10 seconds.

---

## Nutrition Agent

### User profile structure:

```ts
export const userProfile = {
  goal: "muscle gain",            // fitness goal
  diet: "both",                   // 'veg', 'non-veg', or 'both' (flexible)
  dailyProteinGrams: 120,         // grams/day
  dailyCalories: 2200,            // kcal/day
  budgetPerMeal: 250,             // INR, hard limit
  avoid: ["very spicy food"],     // explicit exclusions
  mealTimes: {
    lunch: "12:30",
    dinner: "20:00",
  },
};
```

### Nutrition & Search Intelligence Rules:

1. **Dietary Preference Check (Veg, Non-Veg, or Both)**:
   - When greeting the user or resolving their delivery address (if they haven't stated a preference), ask:
     👉 *"Would you prefer Vegetarian, Non-Vegetarian, or Both/Flexible today?"*
   - If they state a specific dish or diet (e.g. "chicken roll", "egg meal", "paneer roll", "veg thali"), fulfill immediately without asking again.
   - For **Veg**: search with `vegFilter: 1`.
   - For **Non-Veg**: search with `vegFilter: 0`.
   - For **Both**: recommend the top high-protein options across both categories.

2. **User Craving First ("Give Them What They Ask For")**:
   - If the user specifies any dish, craving, or category (e.g. "biryani", "paneer roll", "salad", "sandwich", "pasta", "thali", "dosa", "shake"):
     - **Always search directly for that requested dish** using `search_menu(query: "<dish>", addressId: <id>, vegFilter: 1)`.
     - Present the highest-protein, healthiest, and best-value options of **THAT exact item** within their budget (₹${profile.budgetPerMeal}).
     - Do NOT substitute an unrelated dish if their requested item is available.

2. **Real High-Protein Standards (Strict Anti-Junk Filter)**:
   - When searching for "high protein" or general fitness meals, target genuine protein powerhouses:
     - **Paneer**: Paneer Tikka (Tandoori/Grilled), Paneer Bhurji, Paneer Kathi Roll, Paneer Bowls (~20-30g protein).
     - **Soya**: Soya Chaap (Tandoori/Tikka/Masala), Soya Bhurji, Soya Roll (~25-35g protein).
     - **Lentils & Legumes**: Moong Dal Khichdi, Dal Tadka, Dal Makhani with Roti, Sprouts, Chana Salad (~15-25g protein).
     - **Tofu & Healthy Bowls**: Tofu Stir Fry, Protein Bowls, Greek Yogurt Combos (~18-25g protein).
     - *(If non-veg/egg)*: Boiled Eggs, Egg Bhurji, Grilled Chicken, Chicken Tikka (~25-35g protein).

3. **🚨 Strict Disqualification of Deep-Fried Junk (NO CHOLE BHATURE)**:
   - **NEVER** recommend deep-fried, refined-flour (maida), or heavy carb-loaded junk food as "high protein".
   - **Strictly Banned Items**:
     - ❌ **Chole Bhature** (Bhature is deep-fried refined flour; poor protein-to-calorie density: ~8-10g protein for 750+ kcal and 45g saturated fat).
     - ❌ **Poori Bhaji / Poori Chole** (deep-fried oil bombs).
     - ❌ **Pav Bhaji** (butter-soaked white bread pav with potato mash).
     - ❌ **Samosas, Kachoris, Pakoras, Medu Vada** (deep-fried snack junk).
     - ❌ **French Fries, Fried Momos, Sugary Shakes**.

4. **Hard Budget Cap**:
   - Budget (`budgetPerMeal`) is a hard limit (e.g., ₹250). Never recommend meals exceeding this price.

5. **Transparency & Honesty**:
   - Do not invent nutritional values. If exact verified laboratory data is not published on the menu, label estimates clearly (`~22g protein (estimated)`).
   - Always explain *why* a meal fits the user's fitness goal.

---

## Architecture

### Stack:

| Layer             | Technology                                                |
|-------------------|-----------------------------------------------------------|
| CLI               | Node.js + TypeScript (`src/index.ts`)                     |
| WhatsApp (Meta)   | Official Meta WhatsApp Cloud API (`src/meta-whatsapp-server.ts`) |
| WhatsApp (Twilio) | Twilio Sandbox Webhook (`src/whatsapp-server.ts`)         |
| Cloud Hosting     | Render Web Service (`https://swiggy-mcp-j47z.onrender.com/`) |
| Agent Engine      | Google Gemini 2.5 Flash (`@google/genai`)                 |
| Commerce Protocol | Swiggy Food MCP (`@modelcontextprotocol/sdk`)             |
| Auth              | OAuth 2.1 + PKCE + Dynamic Client Registration            |
| Diagnostics       | Live Health Check (`/healthz`) & Live Log Stream (`/logs`)|

### File structure:

```
f:\swigg_mcp_agent\
├── src/
│   ├── index.ts                ← Interactive CLI entry point
│   ├── agent-core.ts           ← Shared Gemini + Swiggy MCP engine & tool declarations
│   ├── agent-instructions.ts   ← System prompt builder with anti-junk & craving intelligence
│   ├── meta-whatsapp-server.ts ← Meta WhatsApp Cloud API Express server with /healthz & /logs
│   ├── whatsapp-server.ts      ← Twilio WhatsApp sandbox server fallback
│   ├── swiggy-oauth.ts         ← OAuth 2.1 + PKCE provider (headless & interactive)
│   └── user-profile.ts         ← Typed nutrition configuration (budget, protein, diet)
├── .env                        ← (gitignored) secrets & live tokens
├── .env.example                ← Environment template
├── .gitignore                  ← Excludes .env, token-store.json, scratch/
├── package.json                ← Dependencies and run scripts
├── tsconfig.json               ← TypeScript compiler options
└── token-store.json            ← (gitignored) persisted OAuth token
```

Keep Swiggy-specific code isolated from nutrition logic.
Keep OAuth/auth code isolated from agent/runner code.
Each file should have a single clear responsibility.

---

## Security Rules

Never:
- Expose OAuth tokens in frontend JavaScript
- Commit `.env` or `token-store.json` to Git
- Log access tokens, authorization codes, or PKCE verifiers to disk
- Store authorization codes beyond the exchange step
- Bypass Swiggy authentication
- Scrape Swiggy or reverse engineer undocumented APIs
- Share tokens across different users

Always:
- Use environment variables for secrets
- Keep `.env.example` with variable names only (no values)
- Store tokens in memory or OS keychain, not plaintext files

---

## Error Handling (from Official Docs)

| Situation           | Action                                      |
|---------------------|---------------------------------------------|
| 401 Unauthorized    | Re-run full OAuth flow — never retry same token |
| 5xx on read tools   | Retry with exponential backoff (500ms → 1s → 2s → 4s) |
| `place_food_order` 5xx | Check `get_food_orders` before retrying — NOT idempotent |
| Cart expired        | Rebuild cart, confirm with user             |
| Restaurant closed   | Re-run `search_restaurants`                 |
| Minimum order not met | Prompt user to add items                  |

### Exponential backoff pattern (from official docs):
```ts
const baseMs = 500 * 2 ** (attempt - 1); // 500, 1000, 2000, 4000
const jitterMs = Math.random() * baseMs * 0.3;
await new Promise((r) => setTimeout(r, baseMs + jitterMs));
```

---

## Development Principles

1. Prefer small, testable modules.
2. Use TypeScript types; avoid `any`.
3. Validate external MCP responses before using them.
4. Handle MCP errors gracefully — never crash on a tool failure.
5. Log tool calls with duration and status — never log token values.
6. Keep Swiggy-specific code isolated from nutrition logic.
7. Do not create fake/mock Swiggy tools. Test against the real MCP endpoint.
8. Do not assume a tool exists — verify from official documentation.
9. Do not implement production payment automation in Phase 1.
10. Build the smallest working vertical slice first: OAuth → get_addresses.

---

## MVP Success Criteria

The Phase 1 MVP is complete when:

1. User types: _"Find me a high-protein vegetarian dinner under ₹250."_
2. Agent authenticates with Swiggy (or reuses stored token).
3. Agent calls `get_addresses` and identifies home address.
4. Agent calls `search_restaurants` with the home address.
5. Agent calls `get_restaurant_menu` on relevant restaurants.
6. Agent presents 3 ranked options with estimated protein and price.
7. Agent explains why each option fits the user's goals.
8. User selects one.
9. Agent calls `update_food_cart` to add the item.
10. Agent calls `get_food_cart` to confirm the cart.
11. Agent shows cart summary and waits for explicit confirmation.
12. Agent does NOT call `place_food_order` in Phase 1.

This is a compelling demo. Record it and send to builders@swiggy.in.

---

## Production Path (Future)

**Do not apply for production access yet.**
Build the prototype first, then:

1. Record a short demo video (Loom, Drive, or YouTube unlisted).
2. Apply at `https://mcp.swiggy.com/builders/access/` with:
   - Integration name
   - Redirect URIs
   - Servers you'll call (`food`)
   - Expected volume and use case
   - The demo video link
3. Staging credentials are issued during review.
4. Production follows once staging has been green for ≥ 48 hours.

**Your pitch:**
_"I built an AI nutrition agent that uses Swiggy MCP to convert a user's dietary
goals into personalized meal discovery, cart creation, and ordering."_

---

## Official Documentation URLs

| Resource          | URL                                                          |
|-------------------|--------------------------------------------------------------|
| Builders Club     | https://mcp.swiggy.com/builders/                            |
| LLM-readable docs | https://mcp.swiggy.com/builders/llms-full.txt               |
| Authenticate      | https://mcp.swiggy.com/builders/docs/start/authenticate.md  |
| Food recipe       | https://mcp.swiggy.com/builders/docs/build/recipes/order-food.md |
| OAuth metadata    | https://mcp.swiggy.com/.well-known/oauth-authorization-server |
| Support email     | builders@swiggy.in                                          |

**If this file and the official documentation conflict, the official
documentation takes precedence.**
