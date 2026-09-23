/**
 * AI Nutrition Agent — CLI Chat Interface
 *
 * Runs the interactive terminal chat loop using agent-core.ts.
 */

import "dotenv/config";
import readline from "readline";
import { initAgentContext, runAgentTurn, GEMINI_MODEL } from "./agent-core.js";

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  🍽️  AI Nutrition Agent — Powered by Swiggy MCP   ");
  console.log(`  🤖 Model: ${GEMINI_MODEL}                         `);
  console.log("═══════════════════════════════════════════════════\n");

  let ctx;
  try {
    console.log("🔗 Connecting to Swiggy Food MCP...");
    ctx = await initAgentContext();
    console.log("✓ Connected to Swiggy Food MCP.\n");
  } catch (err: any) {
    console.error("❌  Initialization failed:", err?.message ?? err);
    if (String(err).includes("401")) {
      console.error("  Swiggy token expired. Delete token-store.json and re-run.\n");
    }
    process.exit(1);
  }

  console.log(`👤 Profile: ${ctx.userProfile.goal} · ${ctx.userProfile.diet}`);
  console.log(
    `🎯 Targets: ${ctx.userProfile.dailyProteinGrams}g protein · ` +
      `${ctx.userProfile.dailyCalories} kcal · ₹${ctx.userProfile.budgetPerMeal}/meal\n`
  );
  console.log(`✓ Loaded ${ctx.functionDeclarations.length} Swiggy tools.\n`);

  console.log("─────────────────────────────────────────────────");
  console.log("  Type your request and press Enter.");
  console.log('  Try: "What are my saved Swiggy addresses?"');
  console.log('   Or: "Find me a high-protein vegetarian dinner under ₹250."');
  console.log("  Type 'exit' to quit.");
  console.log("─────────────────────────────────────────────────\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const history: any[] = [];
  const prompt = () => process.stdout.write("\n> You: ");
  prompt();

  for await (const line of rl) {
    const userInput = line.trim();
    if (!userInput) { prompt(); continue; }
    if (userInput.toLowerCase() === "exit") {
      console.log("\n👋 Goodbye!");
      break;
    }

    try {
      process.stdout.write("\n🤖 Agent: thinking...\r");
      const reply = await runAgentTurn(
        ctx,
        history,
        userInput,
        (tools) => {
          process.stdout.write(`\r  🔧 Calling ${tools.length} Swiggy tool(s): ${tools.join(", ")}...  `);
        }
      );
      process.stdout.write("                                                            \r");
      console.log(`\n🤖 Agent: ${reply}`);
    } catch (err: any) {
      if (String(err).includes("401")) {
        console.error(
          "\n❌  Swiggy token expired. Delete token-store.json and re-run.\n"
        );
      } else {
        console.error("\n❌  Error:", err?.message ?? err);
      }
    }

    prompt();
  }

  try { await ctx.mcpClient.close(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
