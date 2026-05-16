const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// Debug info
console.log("DEBUG: process.type:", process.type);

let logSubscribers = [];

function broadcastLog(level, args) {
    const line = `[${level}] ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
    logSubscribers.forEach(win => {
        if (win && !win.isDestroyed()) {
            win.webContents.send("agent-log", line);
        }
    });
}

// Redirect console.* to renderer (task log view).
const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
};
console.log = (...args) => { originals.log(...args); broadcastLog("LOG", args); };
console.info = (...args) => { originals.info(...args); broadcastLog("INFO", args); };
console.warn = (...args) => { originals.warn(...args); broadcastLog("WARN", args); };
console.error = (...args) => { originals.error(...args); broadcastLog("ERROR", args); };

// Env loading order:
// 1) Local project .env (dev) wins when present.
// 2) ~/.ai-agent/.env fills missing vars for packaged installs.
//
// This prevents accidentally using an old/free-tier key from ~/.ai-agent/.env during local development.
require("dotenv").config();
const userEnvPath = path.join(require("os").homedir(), ".ai-agent", ".env");
if (fs.existsSync(userEnvPath)) {
    console.log("📄 Loading fallback .env from:", userEnvPath);
    require("dotenv").config({ path: userEnvPath, override: false });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        backgroundColor: "#00000000", // Transparent hex
        transparent: true,
        vibrancy: 'under-window', // or 'sidebar' | 'fullscreen-ui'
        visualEffectState: 'active',
        titleBarStyle: 'hiddenInset', // Adds traffic light buttons back to the top-left
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    logSubscribers.push(win);
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function applyConfigEnv() {
    try {
        const configPath = path.join(app.getPath("userData"), "config.json");
        if (!fs.existsSync(configPath)) return;
        const data = JSON.parse(fs.readFileSync(configPath, "utf8") || "{}");
        // Settings saved in the app should win over fallback env files to avoid accidentally using an old/free-tier key.
        if (data.GEMINI_API_KEY) process.env.GEMINI_API_KEY = String(data.GEMINI_API_KEY);
        if (data.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = String(data.TELEGRAM_BOT_TOKEN);
        if (data.TELEGRAM_ADMIN_ID) process.env.TELEGRAM_ADMIN_ID = String(data.TELEGRAM_ADMIN_ID);
    } catch (e) {
        console.error("Config env apply error:", e?.message || e);
    }
}

app.whenReady().then(() => {
    applyConfigEnv();
    createWindow();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

const configPath = path.join(app.getPath("userData"), "config.json");

ipcMain.handle("get-api-key", () => {
    if (!fs.existsSync(configPath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
        return data.GEMINI_API_KEY || null;
    } catch (e) {
        return null;
    }
});

ipcMain.handle("save-api-key", (_, key) => {
    if (!key || key.length < 10) return false;
    try {
        const existing = fs.existsSync(configPath)
            ? JSON.parse(fs.readFileSync(configPath, "utf8"))
            : {};
        const updated = { ...existing, GEMINI_API_KEY: key };
        fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
        process.env.GEMINI_API_KEY = key;
        return true;
    } catch (e) {
        return false;
    }
});

ipcMain.handle("get-settings", () => {
    if (!fs.existsSync(configPath)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
        return {
            GEMINI_API_KEY: data.GEMINI_API_KEY || "",
            TELEGRAM_BOT_TOKEN: data.TELEGRAM_BOT_TOKEN || "",
            TELEGRAM_ADMIN_ID: data.TELEGRAM_ADMIN_ID || ""
        };
    } catch (e) {
        return {};
    }
});

ipcMain.handle("save-settings", (_, settings) => {
    try {
        const existing = fs.existsSync(configPath)
            ? JSON.parse(fs.readFileSync(configPath, "utf8"))
            : {};
        const updated = {
            ...existing,
            TELEGRAM_BOT_TOKEN: settings.TELEGRAM_BOT_TOKEN || existing.TELEGRAM_BOT_TOKEN || "",
            TELEGRAM_ADMIN_ID: settings.TELEGRAM_ADMIN_ID || existing.TELEGRAM_ADMIN_ID || ""
        };
        fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
        process.env.TELEGRAM_BOT_TOKEN = updated.TELEGRAM_BOT_TOKEN;
        process.env.TELEGRAM_ADMIN_ID = updated.TELEGRAM_ADMIN_ID;
        return true;
    } catch (e) {
        return false;
    }
});

let currentAbortController = null;

ipcMain.handle("stop-agent", () => {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        console.log("🛑 Agent Stop Signal Received");
        return true;
    }
    return false;
});

ipcMain.handle("run-task", async (_, goal) => {
    try {
        // [MODIFIED] DIRECT EXECUTION (No Router)
        // User requested to remove "Front Desk" router since UI has separate tabs.
        // Input from Task Tab is ALWAYS a Task.

        // 2. It's a Task: Proceed with Agent
        currentAbortController = new AbortController();
        const { signal } = currentAbortController;

        // Dynamic import for agent (ESM)
        const { default: runAgent } = await import("../agent-v3.mjs");

        // Loop until completion
        let iterations = 0;
        const maxIterations = 50;
        const runId = `ui:${Date.now()}`;

        while (iterations < maxIterations) {
            if (signal.aborted) {
                return { success: true, result: { message: "Task stopped by user" } };
            }

            console.log(`DEBUG: Loop iteration ${iterations + 1}`);
            // Pass signal to agent to check inside its steps
            const result = await runAgent(goal, { signal, runId });

            if (signal.aborted) {
                return { success: true, result: { message: "Task stopped by user" } };
            }

            if (result.stop) {
                currentAbortController = null;
                if (result.ask_user) {
                    return { success: true, result: { ...result, message: "User input required" } };
                }
                return { success: true, result: { ...result, message: "Task completed" } };
            }

            // If the agent is rate-limited, wait the requested backoff time instead of retry-spamming.
            const waitMatch = typeof result.result === "string" ? result.result.match(/^rate_limited_wait:(\d+)$/) : null;
            if (waitMatch) {
                const waitMs = Math.max(500, Math.min(120000, parseInt(waitMatch[1], 10) || 1000));
                console.log(`DEBUG: Rate limited. Waiting ${waitMs}ms before retry...`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                await new Promise(r => setTimeout(r, 250));
            }
            iterations++;
        }

        currentAbortController = null;
        return { success: true, result: { message: "Max iterations reached" } };

    } catch (err) {
        currentAbortController = null;
        console.error(err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle("upload-document", async (_, filePath) => {
    try {
        if (!fs.existsSync(filePath)) throw new Error("File not found");

        const content = fs.readFileSync(filePath, "utf8");
        const filename = path.basename(filePath);

        const { default: memory } = await import("../memory.mjs");
        const result = await memory.ingestDocument(filename, content);

        return result;
    } catch (err) {
        console.error("Upload error:", err);
        throw new Error(err.message);
    }
});

ipcMain.handle("chat-only", async (_, message) => {
    try {
        const { generateChatResponse } = await import("../chat.mjs");
        const reply = await generateChatResponse(message);
        return reply;
    } catch (err) {
        console.error("Chat Error:", err);
        return "Sorry, I am unable to chat right now.";
    }
});
