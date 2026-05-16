import dotenv from "dotenv";
dotenv.config();

async function listModels() {
    const API_KEY = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.models) {
            console.log("Available Models:");
            data.models.forEach(m => {
                if (m.name.includes("embed") || m.supportedGenerationMethods.includes("embedContent")) {
                    console.log(`- ${m.name}`);
                    console.log(`  Methods: ${m.supportedGenerationMethods.join(", ")}`);
                }
            });
        } else {
            console.error("Error listing models:", JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.error("Fetch failed:", e.message);
    }
}

listModels();
