import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import memory from "./memory.mjs";

dotenv.config();

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

function normalizeChatReply(raw = "") {
    let reply = String(raw || "").trim();
    if (!reply) return reply;

    // Convert fenced shell blocks to plain command text so it does not pollute downstream memory/context.
    const fenceMatch = reply.match(/```(?:bash|zsh|sh)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        const commandText = fenceMatch[1]
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .join("\n")
            .trim();
        if (commandText) return commandText;
    }

    // Remove stray markdown fences if present.
    reply = reply.replace(/```(?:bash|zsh|sh|json)?/gi, "").replace(/```/g, "").trim();
    return reply;
}

// Helper: Extract structured memories (Facts vs Personal vs Contextual)
async function extractAndSaveMemories(userInput) {
    try {
        // Use a single model family consistently for chat extraction.
        const modelName = "gemini-3-flash-preview";

        // Prompt to categorize info
        const extractionPrompt = `Analyze the User's input: "${userInput}"
        Extract meaningful details into these categories:
        1. "Personal": Name, Age, Job, Preferences, User-specific facts.
        2. "Factual": Specific definitions, project specs, technical facts.
        3. "Contextual": Immediate goal, current activity, emotional state, "what we are doing right now".
        
        Return JSON ONLY:
        {
            "has_memory": boolean,
            "memories": [
                { "text": "User's name is Teeyansh", "type": "personal" },
                { "text": "Project is about AI Agents", "type": "factual" },
                { "text": "User is debugging the chat button", "type": "contextual" }
            ]
        }
        If nothing worth remembering (greeting, small talk), return { "has_memory": false }.`;

        const result = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: "user", parts: [{ text: extractionPrompt }] }]
        });

        let text = "";
        if (result.response) {
            text = result.response.text();
        } else if (result.candidates && result.candidates.length > 0) {
            const part = result.candidates[0].content.parts[0];
            text = typeof part === 'string' ? part : part.text;
        }

        // Clean JSON
        const jsonStr = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const data = JSON.parse(jsonStr);

        if (data.has_memory && data.memories) {
            for (const mem of data.memories) {
                console.log(`🧠 Storing [${mem.type}]: ${mem.text}`);
                await memory.add(mem.text, { type: mem.type, source: "chat_extraction" });
            }
        }
    } catch (e) {
        // Non-blocking error
        console.warn("Memory Extraction Warning:", e.message);
    }
}

// PURE CHAT HANDLER (UI Separates Chat vs Task)
// [NEW] Shared Memory Integration
export async function generateChatResponse(input) {
    try {
        // 1. Parallel: Extract & Save new memories from this input
        await extractAndSaveMemories(input);

        // 2. Retrieve Relevant Memories (Now includes what we just saved!)
        const memories = await memory.search(input, 5);

        // Prioritize Memories in Context
        const personalMems = memories.filter(m => m.metadata?.type === 'personal').map(m => `[PERSONAL] ${m.text}`);
        const contextMems = memories.filter(m => m.metadata?.type === 'contextual').map(m => `[CONTEXT] ${m.text}`);
        const factMems = memories.filter(m => !['personal', 'contextual'].includes(m.metadata?.type)).map(m => `[FACT] ${m.text}`);

        const context = [...personalMems, ...contextMems, ...factMems].join("\n");

        const systemPrompt = `You are a helpful AI Computer Assistant with expertise in terminal and file system operations.

TERMINAL-FIRST APPROACH FOR FILE OPERATIONS:
==============================================
When users ask about files, folders, or file system operations:
- DO NOT use Spotlight search (Cmd+Space) for file/folder operations
- DO NOT use Finder to navigate or manage files/folders
- ALWAYS prefer terminal commands for speed and precision
- Examples of terminal commands to use:
  * mkdir <folder_name> - Create folders (NOT Finder)
  * ls / find - List and search files
  * cp / mv - Copy and move files
  * open <file> - Open files
  * rm - Delete files/folders (with care)

APPLICATION OPENING GUIDELINES:
==============================
- For applications: Use direct terminal commands when possible
  * open -a "Application Name" - Open by name
  * open -a "Google Chrome" "https://www.youtube.com/results?search_query=llm+agent+macos" - Open URL in specific app
  * open Chrome - Simple app launch
- Only use Spotlight (Cmd+Space) if terminal command doesn't work
- For Chrome/browsers: Use terminal open command, NOT Spotlight
- For other apps: Check if there's a terminal command first

DIRECT SEARCH & OPENING (TERMINAL-ONLY) - CRITICAL RULES:
=========================================================
✅ DO THIS: Open Chrome with search already executed (ONE command)
❌ DON'T DO THIS: Open Chrome + manually type search query

For ANY search (Google, YouTube, GitHub, Stack Overflow, etc.):
→ Build the search URL as a parameter to 'open -a'
→ Chrome opens with search ALREADY DONE
→ No typing, no UI automation, no Cmd+F

SEARCH EXAMPLES (ALL TERMINAL):
==============================
🔍 Google Search:
  open -a "Google Chrome" "https://www.google.com/search?q=gemini+computer+use+agent"

🎥 YouTube Search:
  open -a "Google Chrome" "https://www.youtube.com/results?search_query=llm+agent+macos"

💻 GitHub Search:
  open -a "Google Chrome" "https://github.com/search?q=macos+automation+llm"

📚 Stack Overflow Search:
  open -a "Google Chrome" "https://stackoverflow.com/search?q=apple+script+terminal"

🤖 ChatGPT Search:
  open -a "Google Chrome" "https://chat.openai.com/?q=terminal+automation"

📖 Documentation Sites:
  open -a "Google Chrome" "https://docs.example.com/search?q=your+query"

OPENING WEBSITES/PAGES (No Search):
===================================
  open -a "Google Chrome" "https://openai.com"
  open -a "Google Chrome" "https://github.com"

OPENING MULTIPLE TABS AT ONCE:
==============================
  open -a "Google Chrome" \\
    "https://google.com/search?q=macos+agent" \\
    "https://github.com/search?q=computer+use"

WHEN USER REQUESTS FILES/FOLDERS:
=================================
- "Get me file X" → Use terminal find/locate commands
- "Send me images from folder Y" → Use terminal to list files (ls, find)
- "Find all files with X" → Use grep, find, or locate commands
- "Create folder Desktop" → Use mkdir, NOT Finder
- Always retrieve results via terminal and prioritize command-line tools

FALLBACK APPROACH:
==================
If you don't know the exact terminal command for something:
- Ask the user for clarification
- Suggest what commands to try (grep, find, mkdir, etc.)
- Use your knowledge of common macOS/Linux commands
- Terminal is ALWAYS the preferred approach

RESPONSE FORMAT:
================
- Return plain text only.
- Do NOT wrap commands in markdown code fences.
- If giving a command, return only the command line(s), nothing else.

MEMORY CONTEXT (Things you know about the user/past):
${context}

User Input: ${input}`;

        // FIX: Use new SDK syntax for Chat
        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts: [{ text: systemPrompt }] }]
        });

        console.log("DEBUG: Chat Gen Result:", JSON.stringify(result, null, 2));

        let reply = "";
        // Helper function to extract text safely
        if (typeof result.text === 'function') {
            reply = result.text();
        } else if (result.candidates && result.candidates.length > 0) {
            // Raw format fallback
            const part = result.candidates[0].content.parts[0];
            reply = typeof part === 'string' ? part : part.text;
        } else {
            reply = "No response generated (Invalid format). Check console.";
        }

        // 3. Store the interaction itself (Conversation History)
        const normalizedReply = normalizeChatReply(reply);
        await memory.add(
            `CHAT: USER=${input} | ASSISTANT=${normalizedReply}`,
            { type: "chat", persistence: "session", source: "chat_interaction" }
        );

        return normalizedReply;
    } catch (e) {
        console.error("Chat Gen Error:", e.message);
        return "I'm having trouble connecting to the chat brain.";
    }
}
