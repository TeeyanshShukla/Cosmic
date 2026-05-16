import tools from "./tools.mjs";

async function executeToolCalls(response) {
    const parts = response.candidates[0].content.parts;
    let shouldTakeScreenshot = false;
    let hasToolCalls = false;

    for (const part of parts) {
        if (part.functionCall) {
            hasToolCalls = true;
            const { name, args } = part.functionCall;

            console.log("🧠 Gemini requested:", name, args);

            const result = await tools[name](args || {});
            console.log("🦾 Tool result:", result);

            // Only take screenshot if it wasn't already a screenshot action
            if (name !== 'take_screenshot') {
                shouldTakeScreenshot = true;
            }
        } else if (part.text) {
            console.log("⚠️  Gemini responded with text instead of tool call:", part.text);
        }
    }

    // Take one screenshot after all actions are complete
    if (shouldTakeScreenshot) {
        await tools.take_screenshot();
    }

    return hasToolCalls;
}

export default executeToolCalls;
