/**
 * 🤖 Telegram Bot for AI Computer Agent (Fast/Responsive)
 */

import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dns from 'dns';
import crypto from 'crypto';
import dotenv from 'dotenv';
import runAgent from './agent-v3.mjs';
import tools from './tools.mjs';

dotenv.config();
// Prefer IPv4 to avoid intermittent IPv6 routing/DNS edge cases on some networks.
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

const DEFAULT_TOKEN = '';
const DEFAULT_ADMIN_ID = '';

// Prevent multiple concurrent instances (avoids Telegram 409 conflicts and "bot not responding").
const SINGLETON_LOCK_PATH = path.join(os.tmpdir(), "ai-computer-agent-telegram.lock");
let singletonFd = null;
function acquireSingletonLock() {
    const tryOnce = () => {
        singletonFd = fs.openSync(SINGLETON_LOCK_PATH, "wx");
        const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
        fs.writeSync(singletonFd, payload);
        fs.closeSync(singletonFd);
        singletonFd = null;
        return true;
    };

    for (let attempt = 1; attempt <= 8; attempt++) {
        try {
            return tryOnce();
        } catch (e) {
            if (!e || e.code !== "EEXIST") throw e;

            // Lock exists. If stale, remove it.
            let alivePid = null;
            try {
                const raw = fs.readFileSync(SINGLETON_LOCK_PATH, "utf8");
                const info = JSON.parse(raw || "{}");
                const pid = Number(info.pid);
                if (pid && Number.isFinite(pid)) {
                    try {
                        process.kill(pid, 0);
                        alivePid = pid;
                    } catch {
                        // stale pid
                    }
                }
            } catch {}

            if (!alivePid) {
                try { fs.unlinkSync(SINGLETON_LOCK_PATH); } catch {}
                continue;
            }

            // Another instance is still alive. This commonly happens during fast hot-reloads.
            // Wait briefly and retry to avoid a "no bot running" gap.
            const waitMs = 400 * attempt;
            console.error(`⏳ Bot lock held by pid=${alivePid}. Waiting ${waitMs}ms (attempt ${attempt}/8)...`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
            continue;
        }
    }

    console.error("❌ Failed to acquire singleton lock after retries. Exiting.");
    return false;
}
function releaseSingletonLock() {
    try { fs.unlinkSync(SINGLETON_LOCK_PATH); } catch {}
}

function loadConfig() {
    try {
        const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Cosmic AI', 'config.json');
        if (!fs.existsSync(configPath)) return {};
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

const cfg = loadConfig();
const TOKEN = cfg.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || DEFAULT_TOKEN;
const ADMIN_ID = Number(cfg.TELEGRAM_ADMIN_ID || process.env.TELEGRAM_ADMIN_ID || DEFAULT_ADMIN_ID);

// Prefer the app-saved key when present. This avoids accidentally using an old/free-tier key from other env sources.
if (cfg.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = String(cfg.GEMINI_API_KEY);
}

if (!TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is missing. Run `cosmic setup` and configure your token.");
    process.exit(1);
}

if (!Number.isFinite(ADMIN_ID) || ADMIN_ID <= 0) {
    console.error("❌ TELEGRAM_ADMIN_ID is missing/invalid. Run `cosmic setup` and configure admin ID.");
    process.exit(1);
}

if (!acquireSingletonLock()) {
    process.exit(0);
}

// Long-polling with a longer server-side timeout reduces request churn and is more resilient on shaky networks.
const bot = new TelegramBot(TOKEN, {
    polling: {
        interval: 1000,
        autoStart: false,
        params: { timeout: 30 }
    },
    request: {
        timeout: 65000
    }
});

console.log('🤖 Telegram Bot Starting (FAST MODE)...');
console.log(`✅ Admin ID: ${ADMIN_ID}`);

async function safeSendMessage(chatId, text, opts = undefined) {
    try {
        const preview = String(text || "").slice(0, 120).replace(/\s+/g, " ");
        console.log(`➡️ sendMessage chat=${chatId} text="${preview}${String(text || "").length > 120 ? "..." : ""}"`);
        const res = await bot.sendMessage(chatId, text, opts);
        console.log(`✅ sendMessage ok chat=${chatId} message_id=${res?.message_id ?? "?"}`);
        return res;
    } catch (e) {
        console.error("❌ sendMessage failed:", e?.message || e);
        return null;
    }
}

let pollingStarted = false;
let pollingStartInFlight = false;
async function startPollingWithBackoff() {
    if (pollingStartInFlight) return;
    pollingStartInFlight = true;
    // Some networks and startup states can transiently break Telegram requests right after login.
    // We verify connectivity (getMe) before starting long-polling to avoid restart storms.
    let attempt = 0;
    try {
        while (true) {
            attempt++;
            try {
                await new Promise((r) => setTimeout(r, Math.min(12000, 1500 * attempt)));

                // If something already started polling (e.g. after a restart), don't create a second getUpdates loop.
                try {
                    if (bot.isPolling()) {
                        pollingStarted = true;
                        console.log("✅ Polling already active");
                        return;
                    }
                } catch {}

                const withTimeout = async (p, ms, label) => {
                    let t = null;
                    const timeoutP = new Promise((_, rej) => {
                        t = setTimeout(() => rej(new Error(`${label}_timeout_${ms}ms`)), ms);
                    });
                    try {
                        return await Promise.race([p, timeoutP]);
                    } finally {
                        if (t) clearTimeout(t);
                    }
                };

                // Only timeout the "connectivity check"; do NOT timeout startPolling or we risk overlapping long-polls (409).
                await withTimeout(bot.getMe(), 12000, "getMe");

                if (!bot.isPolling()) {
                    await bot.startPolling();
                }
                pollingStarted = true;
                console.log("✅ Polling started");
                // Startup ping so it's obvious the bot is alive.
                safeSendMessage(ADMIN_ID, "Bot online (polling active).").catch(() => {});
                return;
            } catch (e) {
                const msg = String(e?.message || e || "");
                console.error(`❌ startPolling failed (attempt ${attempt}):`, msg);
                // Keep retrying indefinitely; launchd KeepAlive is a second layer of protection.
            }
        }
    } finally {
        pollingStartInFlight = false;
    }
}
startPollingWithBackoff();

// Per-chat run control so /stop cancels reliably.
const activeRuns = new Map(); // chatId -> { running: boolean, abort: AbortController, runId: string }
const pendingSelections = new Map();
const pendingQuestions = new Map();

// Hot-reload: if bot/agent code *content* changes, exit. launchd KeepAlive will restart us.
// Uses hashing to avoid false positives from mtime jitter.
// Enabled by default because this is a local single-user agent; disable via BOT_HOT_RELOAD=0.
if (String(process.env.BOT_HOT_RELOAD || "1") !== "0") {
    const RESTART_WATCH_FILES = [
        path.join(process.cwd(), 'telegram-bot-fixed-v2.js'),
        path.join(process.cwd(), 'agent-v3.mjs'),
        path.join(process.cwd(), 'tools.mjs'),
        path.join(process.cwd(), 'toolSchema.js')
    ];
    const state = new Map(); // file -> { size, mtimeMs, hash }
    const hashFile = (p) => {
        const buf = fs.readFileSync(p);
        return crypto.createHash("sha1").update(buf).digest("hex");
    };
    for (const f of RESTART_WATCH_FILES) {
        try {
            if (!fs.existsSync(f)) continue;
            const st = fs.statSync(f);
            state.set(f, { size: st.size, mtimeMs: st.mtimeMs, hash: hashFile(f) });
        } catch {}
    }
    let hotReloadPending = false;
    let hotReloadSince = 0;
    const idleEnoughToRestart = () => {
        // Do not restart mid-run or while waiting for user input for an active run.
        for (const [, r] of activeRuns.entries()) {
            if (r?.running) return false;
        }
        if (pendingQuestions.size > 0) return false;
        return true;
    };

    setInterval(() => {
        for (const f of RESTART_WATCH_FILES) {
            try {
                if (!fs.existsSync(f)) continue;
                const st = fs.statSync(f);
                const prev = state.get(f);
                if (!prev) {
                    state.set(f, { size: st.size, mtimeMs: st.mtimeMs, hash: hashFile(f) });
                    continue;
                }
                if (st.size === prev.size && st.mtimeMs === prev.mtimeMs) continue;
                const nextHash = hashFile(f);
                if (nextHash !== prev.hash) {
                    console.log(`🔁 Code change detected (${path.basename(f)}). Will restart when idle...`);
                    hotReloadPending = true;
                    hotReloadSince = Date.now();
                }
                state.set(f, { size: st.size, mtimeMs: st.mtimeMs, hash: nextHash });
            } catch {}
        }
        // Debounce and only restart when the bot is idle.
        if (hotReloadPending && idleEnoughToRestart() && (Date.now() - hotReloadSince) >= 2200) {
            console.log("🔁 Restarting now (idle + debounced).");
            process.exit(0);
        }
    }, 1200).unref?.();
}

const SCREENSHOT_DIR_CANDIDATES = [
    path.join(os.homedir(), 'Documents', 'Screenshots'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Pictures', 'Screenshots')
];

const escapeMarkdown = (text) => {
    if (!text) return '';
    return String(text).replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

function isAuthorized(msg) {
    return msg.from.id === ADMIN_ID;
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function escapeOsascriptString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function listRecentFiles(dirPath, limit = 10, exts = []) {
    if (!fs.existsSync(dirPath)) return [];
    const items = fs.readdirSync(dirPath)
        .map(name => ({ name, fullPath: path.join(dirPath, name) }))
        .filter(item => {
            if (!fs.existsSync(item.fullPath)) return false;
            const stat = fs.statSync(item.fullPath);
            if (!stat.isFile()) return false;
            if (exts.length === 0) return true;
            const lower = item.name.toLowerCase();
            return exts.some(ext => lower.endsWith(ext));
        })
        .map(item => {
            const stat = fs.statSync(item.fullPath);
            return { ...item, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit);
    return items;
}

function listRecentScreenshots(limit = 10) {
    const exts = ['.png', '.jpg', '.jpeg', '.heic', '.webp'];
    const all = [];
    for (const dirPath of SCREENSHOT_DIR_CANDIDATES) {
        if (!fs.existsSync(dirPath)) continue;
        const files = listRecentFiles(dirPath, Math.max(limit * 3, 30), exts)
            .filter((f) => /screenshot|screen shot|screen_shot|screen-shot/i.test(f.name));
        all.push(...files);
    }
    return all
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit);
}

async function promptSelection(chatId, label, files) {
    if (files.length === 0) {
        return safeSendMessage(chatId, `❌ No ${label} found`);
    }
    pendingSelections.set(chatId, { label, files });
    const list = files.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
    const msg = `✅ Found ${files.length} ${label}:\n\n${list}\n\nReply with numbers (e.g., 1,3) or 'cancel'.`;
    return safeSendMessage(chatId, msg);
}

function parseSelection(text, max) {
    const cleaned = text.replace(/\s+/g, '');
    if (!cleaned) return [];
    return cleaned.split(',')
        .map(n => parseInt(n, 10))
        .filter(n => Number.isFinite(n) && n >= 1 && n <= max);
}

// Log all messages + handle selection replies
bot.on('message', async (msg) => {
    console.log(`📬 Message from ${msg.chat.id} (${msg.from?.username || 'unknown'}): ${msg.text || '[non-text]'}`);
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (text.startsWith('/')) return;

	if (pendingQuestions.has(chatId)) {
	    const { goal, runId: pendingRunId } = pendingQuestions.get(chatId);
	    pendingQuestions.delete(chatId);
	    const updatedGoal = `${goal}\nUser input: ${text}`;
	    await safeSendMessage(chatId, '⏳ Continuing with your answer...');
	    const existing = activeRuns.get(chatId);
	    if (existing?.running) {
	        try { existing.abort?.abort(); } catch {}
	    }
	    const abort = new AbortController();
	    // Reuse the same runId when continuing after a question so agent state is preserved
	    // (opened URL, completed steps, loop-break state, etc).
	    const contRunId = pendingRunId || existing?.runId || `tg:${chatId}:${Date.now()}`;
	    activeRuns.set(chatId, { running: true, abort, runId: contRunId });
	    let loopCount = 0;
	    const MAX_STEPS = 25;
	    while (activeRuns.get(chatId)?.running && loopCount < MAX_STEPS) {
            loopCount++;
            const run = activeRuns.get(chatId);
            if (!run?.running) break;
            const result = await runAgent(updatedGoal, { signal: run.abort?.signal, runId: run.runId });
            if (result.stop) {
                const r = activeRuns.get(chatId);
                if (r) r.running = false;
	        if (result.error) {
	            await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(result.error)}`);
	        } else if (result.ask_user && result.question) {
	            pendingQuestions.set(chatId, { goal: updatedGoal, runId: run.runId });
	            await safeSendMessage(chatId, `❓ ${result.question}\nReply with your answer.`);
	        } else {
	            const msgText = result.result ? `✅ Done: ${escapeMarkdown(result.result)}` : '✅ Done!';
	            await safeSendMessage(chatId, msgText);
	        }
                return;
            }
            if (result.error) {
                const r = activeRuns.get(chatId);
                if (r) r.running = false;
                await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(result.error)}`);
                return;
            }

            const waitMatch = typeof result.result === "string" ? result.result.match(/^rate_limited_wait:(\d+)$/) : null;
            if (waitMatch) {
                const waitMs = Math.max(500, Math.min(120000, parseInt(waitMatch[1], 10) || 1000));
                await safeSendMessage(chatId, `⏳ Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s then retrying...`);
                const run = activeRuns.get(chatId);
                if (!run?.running) break;
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, waitMs);
                    run.abort?.signal?.addEventListener?.("abort", () => {
                        clearTimeout(t);
                        resolve();
                    }, { once: true });
                });
            }
        }
        const r = activeRuns.get(chatId);
        if (r) r.running = false;
        return safeSendMessage(chatId, '⚠️ Max steps reached');
    }

    if (!pendingSelections.has(chatId)) return;

    if (!isAuthorized(msg)) {
        pendingSelections.delete(chatId);
        return safeSendMessage(chatId, '❌ Not authorized');
    }

    if (text.toLowerCase().trim() === 'cancel') {
        pendingSelections.delete(chatId);
        return safeSendMessage(chatId, '✅ Selection cancelled');
    }

    const { label, files } = pendingSelections.get(chatId);
    const selections = parseSelection(text, files.length);
    if (selections.length === 0) {
        return safeSendMessage(chatId, `❌ Invalid selection. Reply with numbers like 1,2 or 'cancel'.`);
    }

    pendingSelections.delete(chatId);
    for (const idx of selections) {
        const file = files[idx - 1];
        try {
            await bot.sendDocument(chatId, file.fullPath, { caption: file.name });
        } catch (e) {
            await safeSendMessage(chatId, `❌ Failed to send: ${file.name}`);
        }
    }
});

// ==================== COMMANDS ====================

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await safeSendMessage(chatId, `🤖 Ready. Type /help for commands.\nChat ID: ${chatId}`);
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const text = `🤖 *AI Computer Agent Bot*

*📝 Execute Tasks*
/run <command> \\- Run agent with custom goal
_Example: /run Create a folder on Desktop_

*📂 File Operations*
/find <filename> \\- Search for files
/get <filepath> \\- Send file via Telegram
/notes \\- Get AI notes automatically
/extract <path> \\- OCR/extract text from a file

*📸 System*
/screenshot \\- Take current screen screenshot
/screenshots \\- List recent screenshots
/wakeup \\- Wake and unlock Mac
/stop \\- Stop running agent
/help \\- Show this help
/start \\- Show welcome message

Tip: Use /screenshots 5 or /screenshots 20 for different counts.

⚠️ Only the admin can use these commands.`;

    try {
        await safeSendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
        await safeSendMessage(chatId, text.replace(/[*_\\]/g, ''));
    }
});

bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) {
        return safeSendMessage(chatId, '❌ Not authorized');
    }

    const run = activeRuns.get(chatId);
    if (run?.running) {
        run.running = false;
        try { run.abort?.abort(); } catch {}
        activeRuns.set(chatId, run);
        pendingQuestions.delete(chatId);
        pendingSelections.delete(chatId);
        await safeSendMessage(chatId, '✅ Stopping (cancel signal sent)');
    } else {
        await safeSendMessage(chatId, 'ℹ️ No agent running');
    }
});

bot.onText(/\/screenshot/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) {
        return safeSendMessage(chatId, '❌ Not authorized');
    }

    try {
        await safeSendMessage(chatId, '📸 Capturing...');
        await tools.take_screenshot();
        const screenshotPath = path.join(os.tmpdir(), 'agent_screen.png');
        if (fs.existsSync(screenshotPath)) {
            await bot.sendPhoto(chatId, screenshotPath);
        } else {
            await safeSendMessage(chatId, '❌ Screenshot failed');
        }
    } catch (error) {
        await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`);
    }
});

bot.onText(/\/screenshots(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) {
        return safeSendMessage(chatId, '❌ Not authorized');
    }

    const requested = parseInt(match?.[1] || '10', 10);
    const limit = [5, 10, 20].includes(requested) ? requested : 10;
    const files = listRecentScreenshots(limit);
    await promptSelection(chatId, 'screenshots', files);
});

bot.onText(/\/run (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) {
        return safeSendMessage(chatId, '❌ Not authorized');
    }

    const command = match[1];
    const existing = activeRuns.get(chatId);
    if (existing?.running) {
        return safeSendMessage(chatId, '⚠️ Agent already running. Send /stop first.');
    }
    const abort = new AbortController();
    const runId = `tg:${chatId}:${Date.now()}`;
    activeRuns.set(chatId, { running: true, abort, runId });
    await safeSendMessage(chatId, `⏳ Executing: "${escapeMarkdown(command)}"`);

    try {
        let loopCount = 0;
        const MAX_STEPS = 25;

        while (activeRuns.get(chatId)?.running && loopCount < MAX_STEPS) {
            loopCount++;
            const run = activeRuns.get(chatId);
            if (!run?.running) break;
            const result = await runAgent(command, { signal: run.abort?.signal, runId: run.runId });

            if (result.stop) {
                const r = activeRuns.get(chatId);
                if (r) r.running = false;
	        if (result.error) {
	            await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(result.error)}`);
	        } else if (result.ask_user && result.question) {
	            pendingQuestions.set(chatId, { goal: command, runId: run.runId });
	            await safeSendMessage(chatId, `❓ ${result.question}\nReply with your answer.`);
	        } else {
	            const msgText = result.result ? `✅ Done: ${escapeMarkdown(result.result)}` : '✅ Done!';
	            await safeSendMessage(chatId, msgText);
	        }
                break;
            } else if (result.error) {
                const r = activeRuns.get(chatId);
                if (r) r.running = false;
                await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(result.error)}`);
                break;
            }

            const waitMatch = typeof result.result === "string" ? result.result.match(/^rate_limited_wait:(\d+)$/) : null;
            if (waitMatch) {
                const waitMs = Math.max(500, Math.min(120000, parseInt(waitMatch[1], 10) || 1000));
                await safeSendMessage(chatId, `⏳ Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s then retrying...`);
                const run = activeRuns.get(chatId);
                if (!run?.running) break;
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, waitMs);
                    run.abort?.signal?.addEventListener?.("abort", () => {
                        clearTimeout(t);
                        resolve();
                    }, { once: true });
                });
            }
        }

        const r = activeRuns.get(chatId);
        if (loopCount >= MAX_STEPS && r?.running) {
            r.running = false;
            await safeSendMessage(chatId, '⚠️ Max steps reached');
        }
    } catch (error) {
        const r = activeRuns.get(chatId);
        if (r) r.running = false;
        await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`);
    } finally {
        const r = activeRuns.get(chatId);
        if (r && !r.running) activeRuns.delete(chatId);
    }
});

bot.onText(/\/find (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) return safeSendMessage(chatId, '❌ Not authorized');

    const filename = match[1];
    await safeSendMessage(chatId, `🔍 Searching for: ${escapeMarkdown(filename)}`);

    exec(`find ~ -name "*${filename}*" -type f 2>/dev/null | head -20`, (error, stdout) => {
        if (error || !stdout.trim()) {
            return safeSendMessage(chatId, '❌ No files found');
        }
        const files = stdout.trim().split('\n').filter(Boolean).slice(0, 20);
        const items = files.map(f => ({ name: path.basename(f), fullPath: f, mtimeMs: 0 }));
        promptSelection(chatId, 'files', items);
    });
});

bot.onText(/\/get (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) return safeSendMessage(chatId, '❌ Not authorized');

    const filepath = match[1].trim();
    const homedir = os.homedir();
    const resolved = path.resolve(filepath);

    if (!resolved.startsWith(homedir)) {
        return safeSendMessage(chatId, '❌ Access denied (home directory only)');
    }

    try {
        if (!fs.existsSync(filepath)) {
            return safeSendMessage(chatId, '❌ File not found');
        }

        const stats = fs.statSync(filepath);
        if (stats.size > 100 * 1024 * 1024) {
            return safeSendMessage(chatId, `❌ File too large (${formatSize(stats.size)})`);
        }

        await safeSendMessage(chatId, `📤 Sending: ${path.basename(filepath)} (${formatSize(stats.size)})`);
        await bot.sendDocument(chatId, filepath);
    } catch (error) {
        await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`);
    }
});

bot.onText(/\/notes/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) return safeSendMessage(chatId, '❌ Not authorized');

    try {
        const paths = ['~/Documents/AI_Notes', '~/Documents/notes', '~/Desktop/notes', '~/Desktop/AI', '~/Notes'];
        const files = [];

        for (const p of paths) {
            const expanded = p.replace('~', os.homedir());
            if (fs.existsSync(expanded)) {
                files.push(...fs.readdirSync(expanded).map(f => path.join(expanded, f)));
            }
        }

        const items = files.slice(0, 20).map(f => ({ name: path.basename(f), fullPath: f, mtimeMs: 0 }));
        await promptSelection(chatId, 'notes', items);
    } catch (error) {
        await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`);
    }
});

bot.onText(/\/extract (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) return safeSendMessage(chatId, '❌ Not authorized');

    const filepath = match[1].trim();
    await safeSendMessage(chatId, '⏳ Extracting text...');
    try {
        const text = await tools.extract_text({ file_path: filepath });
        if (String(text).startsWith("error")) {
            return safeSendMessage(chatId, `❌ ${text}`);
        }
        const snippet = String(text).slice(0, 1500);
        await safeSendMessage(chatId, `✅ Extracted text (first 1500 chars):\n\n${snippet}`);
    } catch (e) {
        await safeSendMessage(chatId, `❌ Error: ${escapeMarkdown(e.message)}`);
    }
});

bot.onText(/\/wakeup/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(msg)) return safeSendMessage(chatId, '❌ Not authorized');

    const password = process.env.MAC_UNLOCK_PASSWORD;
    if (!password) {
        return safeSendMessage(chatId, '❌ MAC_UNLOCK_PASSWORD is not set in environment');
    }

    await safeSendMessage(chatId, '⏳ Waking and unlocking Mac...');
    
    const escaped = escapeOsascriptString(password);
    // Robust unlock: clear any existing input, type password, wait 1s, press Enter.
    const command = `caffeinate -u -t 2 && osascript -e 'tell application "System Events"' -e 'delay 0.3' -e 'keystroke "a" using command down' -e 'key code 51' -e 'delay 0.2' -e 'keystroke "${escaped}"' -e 'delay 1' -e 'key code 36' -e 'end tell'`;

    exec(command, (err) => {
        if (err) {
            safeSendMessage(chatId, '❌ Wakeup failed');
        } else {
            safeSendMessage(chatId, '✅ Wakeup command sent');
        }
    });
});

// ==================== ERROR HANDLING ====================

bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
    const msg = String(error?.message || "");
    // 409 happens when Telegram sees overlapping getUpdates calls. In practice this can get "stuck"
    // if the underlying long-poll cannot be cancelled cleanly. Fastest recovery: restart process
    // and let launchd KeepAlive bring it back up cleanly.
    if (msg.includes("409 Conflict")) {
        console.error("🔁 409 Conflict detected. Exiting so launchd can restart a clean instance.");
        try { bot.stopPolling({ cancel: true, reason: "409_conflict" }); } catch {}
        process.exit(1);
    }
    // 409 can also happen when a previous long-poll overlaps a restart within the same process.
    // Handle it by cancelling and restarting polling with backoff.
    schedulePollingRestart(msg);
});

let pollingRestartTimer = null;
let pollingRestartDelayMs = 2000;
function jitter(ms) {
    const base = Math.max(0, ms | 0);
    const j = Math.floor(base * 0.2 * (Math.random() - 0.5) * 2);
    return Math.max(250, base + j);
}
function schedulePollingRestart(reason = "") {
    if (pollingRestartTimer) return;
    const lower = String(reason || "").toLowerCase();
    if (lower.includes("enotfound") || lower.includes("econnreset") || lower.includes("etimedout")) {
        pollingRestartDelayMs = Math.max(pollingRestartDelayMs, 15000);
    }
    if (lower.includes("eaddrnotavail")) {
        pollingRestartDelayMs = Math.max(pollingRestartDelayMs, 20000);
    }
    const delay = jitter(pollingRestartDelayMs);
    pollingRestartTimer = setTimeout(async () => {
        pollingRestartTimer = null;
        try {
            await bot.stopPolling({ cancel: true, reason: reason || "restart" });
        } catch {}
        try {
            await startPollingWithBackoff();
            pollingRestartDelayMs = 2000;
            console.log('✅ Polling restarted');
        } catch (e) {
            console.error('❌ Polling restart failed:', e.message);
            pollingRestartDelayMs = Math.min(pollingRestartDelayMs * 2, 30000);
            schedulePollingRestart(e?.message || "");
        }
    }, delay);
}

// Periodic guard: ensure polling is running. If not, restart with backoff.
setInterval(() => {
    try {
        if (!pollingStarted) return;
        if (!bot.isPolling()) {
            console.error("⚠️ Polling is not active. Scheduling restart.");
            schedulePollingRestart("polling_inactive");
        }
    } catch {}
}, 30000).unref?.();

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error.message);
    schedulePollingRestart();
});

process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    console.error('❌ Unhandled rejection:', msg);
    schedulePollingRestart();
});

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    for (const [chatId, r] of activeRuns.entries()) {
        r.running = false;
        try { r.abort?.abort(); } catch {}
        activeRuns.set(chatId, r);
    }
    bot.stopPolling();
    releaseSingletonLock();
    process.exit(0);
});
process.on('SIGTERM', () => {
    for (const [chatId, r] of activeRuns.entries()) {
        r.running = false;
        try { r.abort?.abort(); } catch {}
        activeRuns.set(chatId, r);
    }
    try { bot.stopPolling(); } catch {}
    releaseSingletonLock();
    process.exit(0);
});

process.on("exit", () => {
    releaseSingletonLock();
});

console.log('✅ Telegram Bot running!');
