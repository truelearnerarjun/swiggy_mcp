# 🥗 Swiggy MCP AI Nutrition & Meal Ordering Agent

An AI-powered nutrition intelligence and food-ordering agent built on top of the **Swiggy Model Context Protocol (MCP)** and **Google Gemini 2.5 Flash**. 

Instead of browsing endless menus and guessing calories, you define your fitness and macronutrient goals (e.g., *"high-protein vegetarian dinner under ₹250"* or *"healthy paneer roll under ₹200"*), and the agent discovers restaurants, scores dishes for real protein and nutrition, builds your cart, and places orders—accessible via **Terminal CLI**, **WhatsApp (Meta Cloud API)**, or deployed on the **Cloud (Render)**.

---

## ⚡ How It Works

```
                        ┌────────────────────────────────────────────────────────┐
                        │             AI Nutrition Agent                         │
                        │                                                        │
[CLI / WhatsApp]        │  1. Understands user's exact dish request & diet       │
       │                │  2. Resolves delivery address via Swiggy MCP           │
       ▼                │  3. Searches dishes via search_menu with vegFilter     │
[Express Webhook / CLI] │  4. AI scores meals for protein vs price vs budget     │
       │                │  5. Filters out deep-fried junk (anti-junk engine)     │
       ▼                │  6. Recommends top 3 ranked options with reasoning     │
   Google Gemini ◄──────┴───────────────────────────┬────────────────────────────┘
(Function Calling)                                  │
                                                    ▼
                                           Swiggy Food MCP
                                    (https://mcp.swiggy.com/food)
                                                    │
                                           User's Swiggy Account
                                     (Addresses, Cart, Live Orders)
```

---

## ✨ Features

- **🍗 Full Support for Veg, Non-Veg, or Both:**
  - The bot asks upfront: *"Would you prefer Vegetarian, Non-Vegetarian, or Both/Flexible today?"*
  - **Non-Veg Staples:** Grilled/Tandoori Chicken, Chicken Kathi Rolls, Double Egg Wraps, Egg Bhurji, Fish Tikka (~25g-35g protein).
  - **Veg Staples:** Paneer Tikka, Soya Chaap, Dal Tadka/Khichdi Thalis, Tofu, Sprout Bowls (~20g-30g protein).
  - **Both / Flexible:** Recommends a curated mix of top protein options across both categories.
- **🎯 Exact Craving Fulfillment ("Whatever You Ask For"):**
  - Craving biryani, rolls, sandwiches, salads, thalis, or bowls? The agent searches for **what you specifically ask for** rather than defaulting to generic dishes.
- **🚫 Zero-Tolerance Anti-Junk Filter:**
  - Deep-fried, refined-flour (maida) junk is **strictly disqualified** from high-protein recommendations.
  - Banned: **Chole Bhature**, **Poori Bhaji**, **Pav Bhaji**, **Samosas**, **Kachori**, **Deep-Fried Chicken / Wings**, **French Fries**, and sugary shakes.
- **💰 Hard Budget Guardrails:**
  - Never recommends dishes exceeding your target per-meal budget limit (e.g. ₹250).
- **🛵 Live Swiggy MCP Integration:**
  - `get_addresses`: Fetches your real saved Swiggy delivery addresses.
  - `search_menu`: High-precision dish & ingredient search with `vegFilter` (1 for veg, 0 for non-veg).
  - `search_restaurants` & `get_restaurant_menu`: Restaurant discovery and full menu browsing.
  - `update_food_cart` & `get_food_cart`: Seamless cart building and price verification.
- **💳 Intelligent Multi-Option Payment Flow:**
  - **UPI Link / QR:** Generates a live Swiggy UPI payment link/QR for Google Pay, PhonePe, Paytm, and BHIM directly on WhatsApp.
  - **Cash on Delivery (Cash):** Direct COD order placement with explicit user approval.
  - **Card / NetBanking / Swiggy App:** If you prefer paying by card, the bot syncs the cart to your Swiggy account so you can open the official Swiggy app and checkout with cards, Cred, or Swiggy Money!
- **🔒 Secure OAuth 2.1 + PKCE:**
  - Dynamic Client Registration with Swiggy—no credentials or passwords stored; tokens valid for 5 days.
- **📱 Multi-Channel Support:**
  - **Terminal CLI:** Interactive chat in your terminal.
  - **Official Meta WhatsApp Cloud API:** Real-time WhatsApp bot with zero third-party fees.
  - **Twilio WhatsApp:** Alternative sandbox webhook.
- **☁️ 24/7 Cloud Deployment & Diagnostics:**
  - Ready for **Render**, Railway, or VPS.
  - Live health check at `/healthz` showing Meta token validity and active sessions.
  - Live remote logs at `/logs` for real-time troubleshooting.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js + TypeScript
- **AI Brain:** Google Gemini 2.5 Flash (`@google/genai`)
- **Protocol:** Model Context Protocol (`@modelcontextprotocol/sdk`)
- **Commerce Backend:** Swiggy Food MCP Server (`https://mcp.swiggy.com/food`)
- **Authentication:** OAuth 2.1 + PKCE + Express local callback listener
- **Messaging:** Meta WhatsApp Cloud API / Twilio WhatsApp API
- **Deployment:** Render Cloud Web Service (`https://swiggy-mcp-j47z.onrender.com/`)

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js (v18 or higher)
- Free Gemini API Key from [Google AI Studio](https://aistudio.google.com/apikey)
- A Swiggy account (phone number + OTP)

### 2. Clone & Install
```bash
git clone https://github.com/truelearnerarjun/swiggy_mcp.git
cd swiggy_mcp
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Edit `.env`:
```env
# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here

# Swiggy MCP Endpoint (Food server)
SWIGGY_MCP_FOOD_URL=https://mcp.swiggy.com/food

# (Optional) Meta WhatsApp Cloud API
META_WHATSAPP_TOKEN=your_meta_system_user_token
META_PHONE_NUMBER_ID=your_meta_phone_number_id
META_VERIFY_TOKEN=swiggy_agent_secret

# (Optional) Twilio WhatsApp Integration
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
PORT=3000
```

### 4. Configure Your Nutrition Profile
Edit [`src/user-profile.ts`](src/user-profile.ts) to match your fitness targets:
```ts
export const userProfile = {
  goal: "muscle gain",
  diet: "vegetarian",
  dailyProteinGrams: 120,
  dailyCalories: 2200,
  budgetPerMeal: 250,
  avoid: ["very spicy food"],
};
```

---

## 💻 Usage

### Option A: Interactive CLI Mode
```bash
npm start
```
1. On first launch, a browser window opens for one-time Swiggy OAuth login via phone + OTP.
2. The access token is saved locally to `token-store.json` (gitignored, valid for 5 days).
3. Start chatting:
```text
> You: What are my saved Swiggy addresses?
🤖 Agent: I found 8 saved addresses for you...

> You: Use address 6 (Home), find high protein dinner under 250
🤖 Agent: Here are my top 3 high-protein recommendations:
1. Paneer Tikka (3 Pcs) — ₹189 | Charcoal Eats (4.0★) (~20-25g protein)
2. Masala Soya Chaap Kathi Roll — ₹189 | Rolling Fresh (4.8★) (~25-30g protein)
3. Ghee Tadka Dal Khichdi Thali — ₹229 | Daily Kitchen (4.8★) (~20-30g protein)

> You: I want a high protein roll under 250
🤖 Agent: Here are the best rolls for your address:
1. Masala Soya Chaap Kathi Roll — ₹189 | Rolling Fresh (4.8★)
2. Paneer Kathi Roll — ₹189 | Rolling Fresh (4.3★)
3. Soya Chaap Tikka Roll (7") — ₹249 | Charcoal Eats (3.9★)
```

---

### Option B: Official Meta WhatsApp Cloud API
```bash
npm run whatsapp:meta
# or deployed 24/7 on Render!
```
1. Create an app on [Meta for Developers](https://developers.facebook.com) with the **WhatsApp** product.
2. Add your `META_WHATSAPP_TOKEN` (get a Permanent System User Token from Meta Business Suite so it never expires).
3. In Meta WhatsApp Webhook configuration:
   - **Callback URL:** `https://your-domain.onrender.com/webhook`
   - **Verify Token:** `swiggy_agent_secret`
   - **Webhook Fields:** Check `messages`.
4. Message the bot from your phone on WhatsApp!

---

### Option C: Twilio WhatsApp Sandbox
```bash
npm run whatsapp:twilio
```
1. Expose your port with ngrok (`npx ngrok http 3000`).
2. Point Twilio Sandbox Webhook to `https://<ngrok-url>/webhook`.

---

## ☁️ Cloud Deployment (Render)

This repository includes full support for free, 24/7 deployment on [Render](https://render.com):

1. **Create Web Service** on Render connected to this repository (`main` branch).
2. **Build Command:** `npm run build`
3. **Start Command:** `node dist/meta-whatsapp-server.js`
4. **Environment Variables on Render:**
   - `GEMINI_API_KEY`: Your Gemini API key.
   - `SWIGGY_ACCESS_TOKEN`: The 5-day Swiggy OAuth token (from `token-store.json`).
   - `META_WHATSAPP_TOKEN`: Your Meta Cloud API Access Token.
   - `META_PHONE_NUMBER_ID`: Your Meta WhatsApp Phone Number ID.
   - `META_VERIFY_TOKEN`: `swiggy_agent_secret`
   - `PORT`: `10000`

### Diagnostics Endpoints
- **Health Check:** `GET /healthz` (returns server status, active sessions, and Meta token validity).
- **Live Logs:** `GET /logs` (returns recent live execution logs).

---

## 📁 Project Structure

```
├── src/
│   ├── index.ts                # Interactive terminal CLI chat loop
│   ├── agent-core.ts           # Shared Gemini + Swiggy MCP function-calling engine
│   ├── agent-instructions.ts   # System prompt builder with anti-junk & craving intelligence
│   ├── meta-whatsapp-server.ts # Meta WhatsApp Cloud API server (/healthz, /logs)
│   ├── whatsapp-server.ts      # Twilio WhatsApp sandbox server fallback
│   ├── swiggy-oauth.ts         # OAuth 2.1 + PKCE authentication & headless token manager
│   └── user-profile.ts         # Typed nutrition configuration (budget, protein, diet)
├── AGENTS.md                   # Source of truth specification and official Swiggy guidelines
├── .env.example                # Template environment variables
├── .gitignore                  # Protects secrets (.env, token-store.json, scratch/)
├── package.json                # Dependencies and run scripts
└── tsconfig.json               # TypeScript configuration
```

---

## 🔒 Security & Privacy

- **Official OAuth 2.1 + PKCE:** Dynamic Client Registration with Swiggy—no passwords or credit card numbers stored.
- **Git Security:** `.env`, `token-store.json`, and scratch files are strictly gitignored.
- **Explicit Confirmation:** The agent will **never** place an order automatically without explicit user confirmation.

---

## 📜 License
MIT License.
