import runAgent from "./agent-v3.mjs";
import tools from "./tools.mjs";

async function main() {
    const userGoal = "open pewdiepies latest video and give a relevent comment  ";

    console.log("🚀 Starting Planner → Direct Executor Computer Use Agent");
    console.log("🎯 Goal:", userGoal);
    console.log("\n🧠 = Planner (Gemini 2.5 Pro) - Analyzes & Plans");
    console.log("🦾 = Direct Executor - Maps to Tool Calls");

    // Initial observation
    await tools.take_screenshot();

    let iterations = 0;
    const maxIterations = 50;

    while (iterations < maxIterations) {
        console.log(`\n━━━ Iteration ${iterations + 1} ━━━`);
        
        try {
            // 🔁 PLANNER → DIRECT EXECUTOR PIPELINE
            const result = await runAgent(userGoal);
            
            if (result.success) {
                console.log("✅ Action completed successfully");
            } else {
                console.log("❌ Action failed, continuing...");
            }
            
            iterations++;
            
            // Small delay to prevent API overwhelming
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.error("💥 Error in agent loop:", error);
            break;
        }
    }
    
    if (iterations >= maxIterations) {
        console.log("🛑 Reached maximum iterations, stopping.");
    }
}

main().catch(console.error);
