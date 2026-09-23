# 🥗 Swiggy MCP AI Nutrition & Meal Ordering Agent

An AI-powered nutrition intelligence and food-ordering agent built on top of the **Swiggy Model Context Protocol (MCP)** and **Google Gemini 2.5 Flash**. 

Instead of browsing endless menus and guessing calories, you define your fitness and macronutrient goals (e.g., *"high-protein vegetarian dinner under ₹250"*), and the agent discovers restaurants, scores dishes for nutrition, builds your cart, and places orders—accessible via **Terminal CLI** or **WhatsApp**.

---

## ⚡ How It Works

```
                        ┌────────────────────────────────────────────────────────┐
                        │             AI Nutrition Agent                         │
                        │                                                        │
[CLI / WhatsApp]        │  1. Understands fitness goal (e.g. 120g protein/day)   │
       │                │  2. Resolves delivery address via Swiggy MCP           │
       ▼                │  3. Searches open restaurants & live menus             │
[Express Webhook / CLI] │  4. AI scores meals for protein vs price vs budget     │
       │                │  5. Recommends top 3 ranked options with reasoning     │
       ▼                │  6. Adds to cart & asks for explicit order approval    │
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

- **🎯 Personalized Nutrition Scoring:** Ranks dishes based on target macronutrients (e.g. protein, calories, strict dietary preferences like vegetarian/vegan).
- **💰 Hard Budget Guardrails:** Never recommends dishes exceeding your target per-meal budget limit.
- **🛵 Live Swiggy MCP Integration:**
  - `get_addresses`: Automatically fetches your real saved Swiggy delivery addresses.
  - `search_restaurants`: Searches open restaurants matching your dietary requirements.
  - `search_menu` & `get_restaurant_menu`: Live menu inspection with dish prices and availability.
  - `update_food_cart`: Adds selected meals directly to your active Swiggy cart.
- **🔒 Secure OAuth 2.1 + PKCE:** Dynamic Client Registration with Swiggy—no credentials or passwords stored; tokens valid for 5 days.
- **📱 Dual Interface:**
  - **Terminal CLI:** Interactive chat directly in your console.
  - **WhatsApp Bot:** Powered by Twilio with asynchronous reply dispatching (avoids 15-second webhook timeouts) and multi-turn per-user memory.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js + TypeScript
- **AI Brain:** Google Gemini 2.5 Flash (`@google/genai`)
- **Protocol:** Model Context Protocol (`@modelcontextprotocol/sdk`)
- **Commerce Backend:** Swiggy Food MCP Server (`https://mcp.swiggy.com/food`)
- **Authentication:** OAuth 2.1 + PKCE + Express local callback listener
- **Messaging (WhatsApp):** Twilio WhatsApp API + Express Webhook Server

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

# Swiggy MCP Endpoint (default: Food server)
SWIGGY_MCP_FOOD_URL=https://mcp.swiggy.com/food

# (Optional) Twilio WhatsApp Integration
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
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
```
> You: What are my saved Swiggy addresses?
🤖 Agent: I found 8 saved addresses for you...

> You: Use my Home address in Ghansoli, find high protein veg dinner under 250
🤖 Agent: Here are my top 3 recommendations:
1. Dal Tadka Rice Combo from Punjab Depot — ₹249 (~20-25g protein)
2. Kali Dal Meal from Charcoal Eats — ₹249 (~20-25g protein)
3. Chole Bhature from Dadi Ka Khazana — ₹229 (~15-20g protein)
```

---

### Option B: Meta WhatsApp Cloud API (Official)
```bash
npm run whatsapp:meta
```
1. Create an app on [Meta for Developers](https://developers.facebook.com) with the **WhatsApp** product.
2. In your `.env`:
```env
META_WHATSAPP_TOKEN=your_meta_access_token
META_PHONE_NUMBER_ID=your_phone_number_id
META_VERIFY_TOKEN=swiggy_agent_secret
```
3. Expose port 3000 via ngrok: `npx ngrok http 3000`
4. In Meta WhatsApp Configuration, set:
   - **Callback URL:** `https://<your-ngrok-subdomain>.ngrok-free.app/webhook`
   - **Verify Token:** `swiggy_agent_secret`
5. Message the bot from your WhatsApp number!

---

### Option C: Twilio WhatsApp Bot
```bash
npm run whatsapp:twilio
```
1. Expose your local port via ngrok: `npx ngrok http 3000`
2. In your [Twilio Console](https://console.twilio.com) > **WhatsApp Sandbox Settings**, set the webhook URL to:
```
https://<your-ngrok-subdomain>.ngrok-free.app/webhook
```
3. Message the bot from your phone on WhatsApp!
   - Send `/reset` anytime to wipe conversation history and start fresh.

---

## 📁 Project Structure

```
├── src/
│   ├── index.ts              # Interactive terminal CLI chat loop
│   ├── agent-core.ts         # Shared Gemini + Swiggy MCP function-calling engine
│   ├── whatsapp-server.ts    # Twilio Express webhook server & session manager
│   ├── swiggy-oauth.ts       # OAuth 2.1 + PKCE authentication & token manager
│   ├── user-profile.ts       # Typed nutrition configuration (calories, protein, budget)
│   └── agent-instructions.ts # Dynamic system prompt generator
├── AGENTS.md                 # Complete project specification and Swiggy MCP guidelines
├── .env.example              # Template environment variables
├── .gitignore                # Protects secrets (.env, token-store.json)
├── package.json              # Dependencies and scripts
└── tsconfig.json             # TypeScript configuration
```

---

## 🔒 Security & Privacy

- **No Plaintext Passwords:** Uses official Swiggy OAuth 2.1 with PKCE. The agent never sees or stores phone passwords or credit card numbers.
- **Git Security:** `.env` and `token-store.json` are strictly excluded in `.gitignore`.
- **User Confirmation Required:** The agent will **never** place an order automatically without explicit user confirmation.

---

## 📜 License
MIT License.
