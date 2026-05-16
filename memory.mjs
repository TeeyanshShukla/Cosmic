import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import os from "os";
// Store in User Home Directory -> .ai-agent folder
// This ensures data persists across updates and is writable in packaged apps (DMG)
const USER_DATA_DIR = path.join(os.homedir(), ".ai-agent");
if (!fs.existsSync(USER_DATA_DIR)) {
    try {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create data dir:", e);
    }
}
const MEMORY_FILE = path.join(USER_DATA_DIR, "semantic_memory.json");

class AgentMemory {
    constructor() {
        this.persistentMemories = []; // Factual (Long-term)
        this.sessionMemories = [];    // Contextual (Short-term, resets every run)
        this.load();
    }

    load() {
        // Only load Persistent Memory
        if (fs.existsSync(MEMORY_FILE)) {
            try {
                this.persistentMemories = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
                console.log(`🧠 Long-term Memory loaded: ${this.persistentMemories.length} entries.`);
            } catch (e) {
                console.error("⚠️ Error loading memory file:", e.message);
                this.persistentMemories = [];
            }
        } else {
            console.log("🧠 No existing long-term memory found. Creating new.");
            this.persistentMemories = [];
        }

        // RESET Session Memory on Load
        this.sessionMemories = [];
        console.log("🧹 Session/Contextual Memory Reset (New Session Started).");
    }

    resetSession() {
        this.sessionMemories = [];
        console.log("🧹 Manual Session Memory Reset.");
    }

    save() {
        try {
            // Only save Persistent Memory
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.persistentMemories, null, 2));
        } catch (e) {
            console.error("⚠️ Error saving memory:", e.message);
        }
    }

    async add(text, metadata = {}) {
        try {
            console.log(`🧠 Memorizing: "${text.substring(0, 50)}..." [Type: ${metadata.type || 'session'}]`);
            const memoryItem = {
                id: Date.now().toString(),
                text: text,
                embedding: null, // lexical search mode (no embedding API call)
                timestamp: Date.now(),
                metadata: metadata
            };

            // DISTINGUISH STORAGE BASED ON TYPE
            if (metadata.type === "fact" || metadata.persistence === "long-term") {
                this.persistentMemories.push(memoryItem);
                this.save(); // Persist to disk
                console.log("💾 Saved to Long-Term Memory");
            } else {
                this.sessionMemories.push(memoryItem);
                // Do NOT save to disk (Session only)
                console.log("📝 Saved to Session Memory (Ephemeral)");
            }

            return true;
        } catch (error) {
            console.error("❌ Memory Add Error:", error.message);
            return false;
        }
    }

    // [NEW] Structured Interaction Memory (Default: Session/Contextual)
    async addInteraction(userGoal, action, result, feedback = "") {
        const actionStr = typeof action === 'string' ? action : JSON.stringify(action);
        // Format: "ACTION: {act} | RESULT: {res} | GOAL: {goal} | NOTES: {feedback}"
        const memoryText = `ACTION: ${actionStr} | RESULT: ${result} | GOAL: ${userGoal} | NOTES: ${feedback}`;

        return this.add(memoryText, {
            type: "interaction", // Default assumes session/contextual
            persistence: "session",
            action: action,
            result: result,
            goal: userGoal
        });
    }

    // [NEW] Explicit Factual Memory
    async addFact(factText) {
        return this.add(factText, {
            type: "fact",
            persistence: "long-term"
        });
    }

    async search(query, limit = 5) {
        const allMemories = [...this.persistentMemories, ...this.sessionMemories];
        if (allMemories.length === 0) return [];
        
        // Fast lexical scoring to avoid per-step embedding API calls and overloads.
        const queryTokens = String(query || "")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        if (queryTokens.length === 0) return allMemories.slice(-limit).reverse();

        const ranked = allMemories.map(mem => {
            const text = String(mem.text || "").toLowerCase();
            let score = 0;
            for (const token of queryTokens) {
                if (!token) continue;
                if (text.includes(token)) score += 1;
            }
            // Slight recency boost
            const recency = mem.timestamp ? Math.min(1, (Date.now() - mem.timestamp) / (1000 * 60 * 60 * 24)) : 1;
            const similarity = score + (1 - recency) * 0.25;
            return { ...mem, similarity };
        });

        ranked.sort((a, b) => b.similarity - a.similarity);
        return ranked.slice(0, limit);
    }

    async ingestDocument(filename, content) {
        console.log(`📄 Ingesting document: ${filename}`);
        // Simple heuristic chunking
        const chunks = this.chunkText(content, 1500);
        let count = 0;
        for (const chunk of chunks) {
            // Documents are usually factual/reference, so we store them as facts? 
            // Or maybe session if it's just for this task?
            // Let's assume documents ingested via tool are for the session unless specified.
            // For now, defaulting to session to match "contextual reset" request.
            await this.add(chunk, { source: "document", filename: filename, chunkIndex: count, persistence: "session" });
            count++;
        }
        return `Successfully ingested ${count} chunks from ${filename}`;
    }

    chunkText(text, maxLength) {
        if (!text) return [];
        const chunks = [];
        let currentChunk = "";
        // Split by newlines first to preserve paragraph structure approximately
        const paragraphs = text.split(/\n+/);

        for (const para of paragraphs) {
            if ((currentChunk + para).length > maxLength) {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = para;
                // If a single paragraph is too huge, split by sentences
                if (currentChunk.length > maxLength) {
                    // very basic sentence splitter
                    const sentences = currentChunk.split(/(?<=[.?!])\s+/);
                    currentChunk = "";
                    for (const s of sentences) {
                        if ((currentChunk + s).length > maxLength) {
                            if (currentChunk) chunks.push(currentChunk);
                            currentChunk = s;
                        } else {
                            currentChunk += (currentChunk ? " " : "") + s;
                        }
                    }
                }
            } else {
                currentChunk += (currentChunk ? "\n" : "") + para;
            }
        }
        if (currentChunk) chunks.push(currentChunk);
        return chunks.length > 0 ? chunks : [text];
    }
}

const memory = new AgentMemory();
export default memory;
