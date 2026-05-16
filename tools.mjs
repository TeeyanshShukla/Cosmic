import { mouse, keyboard, screen, Key } from "@nut-tree-fork/nut-js";
import screenshot from "screenshot-desktop";
import { execFileSync, execSync, spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const SCREEN_PATH = path.join(os.tmpdir(), "agent_screen.png");

function isAborted() {
    try {
        return Boolean(global.currentAbortSignal && global.currentAbortSignal.aborted);
    } catch {
        return false;
    }
}

function abortedResult() {
    return "error: aborted";
}

// Helper for shortcut lookup
async function queryShortcut(appName, intention) {
    try {
        if (isAborted()) return null;
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const prompt = `You are a Mac Shortcut Expert.
        User wants to perform the action: "${intention}" in the app: "${appName}".
        Return ONLY the keyboard shortcut string compatible with nut.js / active-window interactions.
        Examples: "cmd+k", "opt+cmd+s", "ctrl+c", "space", "f5".
        If no standard shortcut exists, return "null".
        DO NOT explain. ONLY output the string.`;
        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return String(text).trim();
    } catch (e) {
        console.error("Shortcut Lookup Error:", e);
        return null;
    }
}

async function listShortcuts(appName) {
    try {
        if (isAborted()) return "error";
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const prompt = `List the most common keyboard shortcuts for: "${appName}".
If this is a web app in a browser (e.g., Instagram Web, YouTube Web), prioritize shortcuts that work on that site plus essential browser shortcuts.
Return JSON array of objects with keys: action, shortcut.
Example: [{"action":"New Tab","shortcut":"cmd+t"}]
Return ONLY JSON.`;
        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        const text = String(result?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        const jsonStr = text.replace(/```json/g, "").replace(/```/g, "").trim();
        return jsonStr;
    } catch (e) {
        console.error("Shortcut List Error:", e);
        return "error";
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeAppleScriptString(str = "") {
    return String(str)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
}

function runChromeFrontTabJS(script) {
    try {
        if (isAborted()) return abortedResult();
        const escaped = escapeAppleScriptString(script);
        const appleScript = `tell application "Google Chrome"
if (count of windows) is 0 then error "no chrome windows"
set jsResult to execute front window's active tab javascript "${escaped}"
return jsResult
end tell`;
        const out = execFileSync("osascript", ["-e", appleScript], { encoding: "utf8" });
        global.chromeJsDisabled = false;
        return String(out || "").trim();
    } catch (e) {
        const msg = String(e?.message || "");
        const lower = msg.toLowerCase();
        // Chrome blocks JS execution via Apple Events unless user enables:
        // View -> Developer -> Allow JavaScript from Apple Events
        if (
            lower.includes("allow javascript from apple events") ||
            lower.includes("javascript through applescript is turned off") ||
            (lower.includes("apple events") && lower.includes("javascript") && lower.includes("turned off"))
        ) {
            global.chromeJsDisabled = true;
        }
        return `error: ${e.message}`;
    }
}

function runAppleScript(script) {
    if (isAborted()) return abortedResult();
    const out = execFileSync("osascript", ["-e", script], { encoding: "utf8" });
    return String(out || "").trim();
}

function ensureHttpUrl(url) {
    let u = String(url || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
}

function tryParseJson(text) {
    const parsed = extractJsonObject(text);
    if (parsed) return parsed;
    try {
        const cleaned = String(text || "").replace(/```json/g, "").replace(/```/g, "").trim();
        if (!cleaned) return null;
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

function chromeDomQueryScript(params = {}) {
    const selector = params.selector ? String(params.selector) : "";
    const role = params.role ? String(params.role) : "";
    const name = params.name ? String(params.name) : "";
    const text = params.text ? String(params.text) : "";
    const hrefContains = params.href_contains ? String(params.href_contains) : "";
    const type = params.type ? String(params.type) : "";
    const max = Math.max(1, Math.min(50, parseInt(params.max_results, 10) || 12));

    const paramsObj = {
        selector,
        role,
        name,
        text,
        href: hrefContains,
        type,
        max
    };

    return `(function(){try{
  const params=${JSON.stringify(paramsObj)};
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const lower=s=>norm(s).toLowerCase();
  const wantRole=lower(params.role);
  const wantName=lower(params.name);
  const wantText=lower(params.text);
  const wantHref=lower(params.href);
  const wantType=lower(params.type);

  const baseSel = params.selector && params.selector.length
    ? params.selector
    : 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';

  const nodes=[...document.querySelectorAll(baseSel)];
  const visible=nodes.filter(el=>{try{const r=el.getBoundingClientRect();return r.width>1&&r.height>1&&r.bottom>0&&r.right>0;}catch{return false;}});

  const items=[];
  for(const el of visible){
    const tag=String(el.tagName||"").toLowerCase();
    const role=String(el.getAttribute&&el.getAttribute("role")||"").toLowerCase();
    const effRole = role || "textbox";
    const aria=norm(el.getAttribute&&el.getAttribute("aria-label")||"");
    const ph=norm(el.getAttribute&&el.getAttribute("placeholder")||"");
    const href=String(el.getAttribute&&el.getAttribute("href")||"");
    const type=String(el.getAttribute&&el.getAttribute("type")||"").toLowerCase();
    const ce=String(el.getAttribute&&el.getAttribute("contenteditable")||"").toLowerCase()==="true";
    const effRole = role || (tag==="a"?"link":(tag==="button"?"button":((tag==="input"||tag==="textarea"||ce)?"textbox":"")));
    const txt=norm(el.innerText||el.value||"");
    const name=aria||txt||ph||href;
    const hay=(lower(name)+" "+lower(txt)+" "+lower(ph)+" "+lower(href)+" "+tag+" "+role);

    if(wantRole && effRole!==wantRole) continue;
    if(wantType && type!==wantType) continue;
    if(wantName && !hay.includes(wantName)) continue;
    if(wantText && !hay.includes(wantText)) continue;
    if(wantHref && !lower(href).includes(wantHref)) continue;

    items.push({tag,role:effRole,ariaLabel:aria,placeholder:ph,text:txt,href,type});
    if(items.length>=params.max) break;
  }
  return JSON.stringify({ok:true,count:items.length,items});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
}

function extractJsonObject(text) {
    if (!text || typeof text !== "string") return null;
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    try {
        return JSON.parse(cleaned);
    } catch {}
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
        try {
            return JSON.parse(cleaned.slice(first, last + 1));
        } catch {}
    }
    return null;
}


// Record step execution with timing
async function recordToolExecution(toolName, args, resultFn) {
    const startTime = Date.now();
    try {
        const result = await resultFn();
        const duration = Date.now() - startTime;
        
        if (global.stepTracker) {
            global.stepTracker.recordStep(
                toolName,
                args,
                result,
                duration,
                { validated: true }
            );
        }
        
        return result;
    } catch (error) {
        const duration = Date.now() - startTime;
        
        if (global.stepTracker) {
            global.stepTracker.recordStep(
                toolName,
                args,
                null,
                duration,
                { error: error.message, validated: false }
            );
        }
        
        throw error;
    }
}


export const tools = {
    shell: async ({ command, cwd }) => {
        if (isAborted()) return abortedResult();
        if (!command || typeof command !== "string") {
            return "error: command must be a non-empty string";
        }
        const trimmed = command.trim();
        if (!trimmed) {
            return "error: command must be a non-empty string";
        }
        const lower = trimmed.toLowerCase();
        if (lower.includes("rm -rf /") || lower.includes("rm -rf /*") || lower.includes(":(){ :|:& };:")) {
            return "error: command blocked for safety";
        }
        try {
            const workdir = cwd || process.cwd();
            const maxChars = 12000;
            const timeoutMs = 20 * 60 * 1000;

            // Non-blocking shell execution so the Telegram bot stays responsive while long commands run.
            const res = await new Promise((resolve) => {
                const child = spawn("/bin/bash", ["-lc", trimmed], {
                    cwd: workdir,
                    stdio: ["ignore", "pipe", "pipe"]
                });

                let stdoutBuf = "";
                let stderrBuf = "";
                const pushLimited = (buf, chunk) => {
                    buf += chunk;
                    if (buf.length > maxChars) buf = buf.slice(buf.length - maxChars);
                    return buf;
                };

                const killTimer = setTimeout(() => {
                    try { child.kill("SIGTERM"); } catch {}
                    resolve({ code: 124, stdout: stdoutBuf, stderr: stderrBuf, timedOut: true });
                }, timeoutMs);

                child.stdout.setEncoding("utf8");
                child.stderr.setEncoding("utf8");
                child.stdout.on("data", (d) => { stdoutBuf = pushLimited(stdoutBuf, String(d)); });
                child.stderr.on("data", (d) => { stderrBuf = pushLimited(stderrBuf, String(d)); });
                child.on("error", (err) => {
                    clearTimeout(killTimer);
                    resolve({ code: 1, stdout: stdoutBuf, stderr: String(err?.message || err) });
                });
                child.on("close", (code, signal) => {
                    clearTimeout(killTimer);
                    resolve({ code: typeof code === "number" ? code : 1, stdout: stdoutBuf, stderr: stderrBuf, signal });
                });
            });

            if (res.code === 0) {
                const out = String(res.stdout || "").trim();
                return out.length ? out : "ok";
            }
            if (res.timedOut) return "error: command timed out";
            const err = String(res.stderr || res.stdout || "").trim();
            return `error: ${err || `command failed with code ${res.code}`}`;
        } catch (e) {
            return `error: ${e.message}`;
        }
    },
    find_candidate_docs: async ({ query, max_results = 10, roots }) => {
        if (!query || typeof query !== "string") return "error: query required";
        const max = Number.isFinite(max_results) ? max_results : 10;
        const searchRoots = Array.isArray(roots) && roots.length
            ? roots
            : [path.join(os.homedir(), "Documents"), path.join(os.homedir(), "Desktop")];
        const results = [];

        for (const root of searchRoots) {
            if (!fs.existsSync(root)) continue;
            try {
                const cmd = `find "${root}" -type f -iname "*${query.replace(/"/g, '\\"')}*" 2>/dev/null | head -n ${max}`;
                const out = execSync(cmd, { encoding: "utf8" });
                out.split("\n").filter(Boolean).forEach(p => results.push(p));
            } catch (e) {
                // ignore individual root errors
            }
            if (results.length >= max) break;
        }

        if (results.length === 0) return "no_results";
        return `results:\n${results.slice(0, max).join("\n")}`;
    },
    extract_text: async ({ file_path }) => {
        if (!file_path || typeof file_path !== "string") return "error: file_path required";
        const expanded = file_path.replace(/^~(?=$|\/|\\)/, os.homedir());
        if (!fs.existsSync(expanded)) return "error: file not found";

        const ext = path.extname(expanded).toLowerCase();
        try {
            if (ext === ".txt" || ext === ".md" || ext === ".json" || ext === ".csv") {
                return fs.readFileSync(expanded, "utf8");
            }

            if (ext === ".pdf") {
                try {
                    execSync("command -v pdftotext", { stdio: "ignore" });
                    const cmd = `pdftotext -layout -nopgbrk "${expanded}" -`;
                    return execSync(cmd, { encoding: "utf8" });
                } catch {
                    return "error: pdftotext not installed";
                }
            }

            if ([".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".gif", ".heic"].includes(ext)) {
                try {
                    execSync("command -v tesseract", { stdio: "ignore" });
                    const cmd = `tesseract "${expanded}" stdout -l eng`;
                    return execSync(cmd, { encoding: "utf8" });
                } catch {
                    return "error: tesseract not installed";
                }
            }

            return "error: unsupported file type";
        } catch (e) {
            return `error: ${e.message}`;
        }
    },
    gemini_extract_text: async ({ file_path }) => {
        if (!file_path || typeof file_path !== "string") return "error: file_path required";
        const expanded = file_path.replace(/^~(?=$|\/|\\)/, os.homedir());
        if (!fs.existsSync(expanded)) return "error: file not found";
        try {
            const ext = path.extname(expanded).toLowerCase();
            const mimeMap = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".heic": "image/heic",
                ".tiff": "image/tiff",
                ".bmp": "image/bmp",
                ".gif": "image/gif",
                ".pdf": "application/pdf"
            };
            const mimeType = mimeMap[ext] || "application/octet-stream";
            const data = fs.readFileSync(expanded).toString("base64");
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            const prompt = "Extract all readable text from this document/image. Return plain text only.";
            const result = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: prompt },
                            { inlineData: { mimeType, data } }
                        ]
                    }
                ]
            });
            const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            return String(text).trim();
        } catch (e) {
            return `error: ${e.message}`;
        }
    },
    get_active_app: async () => {
        try {
            const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
            const result = execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
            return result.trim();
        } catch (e) {
            return "unknown";
        }
    },
    get_active_browser_url: async () => {
        try {
            const appScript = 'tell application "System Events" to get name of first application process whose frontmost is true';
            const appName = execFileSync("osascript", ["-e", appScript], { encoding: "utf8" }).trim();
            if (!/google chrome|chrome/i.test(appName)) return "";
            const urlScript = `tell application "Google Chrome"
if (count of windows) is 0 then return ""
return URL of active tab of front window
end tell`;
            const url = execFileSync("osascript", ["-e", urlScript], { encoding: "utf8" }).trim();
            return url || "";
        } catch {
            return "";
        }
    },
    take_screenshot: async () => {
        if (isAborted()) return abortedResult();
        const hasValidImage = () => fs.existsSync(SCREEN_PATH) && fs.statSync(SCREEN_PATH).size > 0;
        try {
            await screenshot({ filename: SCREEN_PATH });
            if (hasValidImage()) return "screenshot taken";
        } catch (primaryError) {
            console.error("❌ Screenshot Failed:", primaryError.message);
            try {
                execFileSync("screencapture", ["-x", SCREEN_PATH]);
                if (hasValidImage()) return "screenshot taken";
            } catch {
                try {
                    execFileSync("screencapture", ["-x", "-D", "1", SCREEN_PATH]);
                    if (hasValidImage()) return "screenshot taken";
                } catch {}
            }
            if (String(primaryError.message || "").includes("could not create image")) {
                console.error("⚠️ PERMISSION DENIED: Please grant 'Screen Recording' permission to Terminal/VSCode in System Settings.");
                return "FAILED: Permission Denied (Screen Recording)";
            }
            return `FAILED: ${primaryError.message || "failed to take screenshot"}`;
        }
        return "FAILED: screenshot capture produced empty file";
    },

    click: async () => {
        return "error: mouse disabled; use keyboard navigation";
    },

    move: async () => {
        return "error: mouse disabled; use keyboard navigation";
    },

    type: async ({ text }) => {
        if (isAborted()) return abortedResult();
        if (!text || typeof text !== 'string') {
            return "error: text must be a non-empty string";
        }
        try {
            await keyboard.type(text);
            return "typed";
        } catch (e) {
            console.error("Type Error:", e.message);
            return `failed to type: ${e.message}`;
        }
    },

    scroll: async () => {
        return "error: mouse disabled; use pagedown/pageup keys";
    },

    wait: async ({ ms, seconds }) => {
        if (isAborted()) return abortedResult();
        const waitTime = ms || (seconds * 1000) || 1000;
        await new Promise(r => setTimeout(r, waitTime));
        return "waited";
    },

    // 🎹 NEW KEYBOARD FUNCTIONS
    key: async ({ key }) => {
        if (isAborted()) return abortedResult();
        const keyLower = key.toLowerCase();

        const keyMap = {
            'space': Key.Space,
            'enter': Key.Return,
            'return': Key.Return,
            'tab': Key.Tab,
            'escape': Key.Escape,
            'esc': Key.Escape,
            'backspace': Key.BackSpace,
            'delete': Key.Delete,
            'up': Key.Up,
            'down': Key.Down,
            'left': Key.Left,
            'right': Key.Right,
            'f4': Key.F4,
            'pageup': Key.PageUp,
            'pagedown': Key.PageDown,
        }


        const mappedKey = keyMap[keyLower] || key;
        await keyboard.pressKey(mappedKey);
        return `pressed ${key}`;
    },

    key_combo: async ({ keys }) => {
        if (isAborted()) return abortedResult();
        // Handle key combinations like "cmd+c", "ctrl+v", etc.
        const keyArray = keys.split('+').map(k => k.trim());

        // Map common key names to nut.js Key constants
        const keyMap = {
            'cmd': Key.LeftCmd,
            'leftcmd': Key.LeftCmd,
            'LeftCmd': Key.LeftCmd,
            'rightcmd': Key.RightCmd,
            'RightCmd': Key.RightCmd,
            'command': Key.LeftCmd,
            'ctrl': Key.LeftControl,
            'leftctrl': Key.LeftControl,
            'rightctrl': Key.RightControl,
            'control': Key.LeftControl,
            'alt': Key.LeftAlt,
            'leftalt': Key.LeftAlt,
            'rightalt': Key.RightAlt,
            'shift': Key.LeftShift,
            'leftshift': Key.LeftShift,
            'rightshift': Key.RightShift,
            'space': Key.Space,
            'Space': Key.Space,
            'esc': Key.Escape,
            'escape': Key.Escape,
            'return': Key.Return,
            'enter': Key.Return,
            'tab': Key.Tab,
            'backspace': Key.BackSpace,
            'delete': Key.Delete,
            'up': Key.Up,
            'down': Key.Down,
            'left': Key.Left,
            'right': Key.Right,
            'home': Key.Home,
            'end': Key.End,
            'pageup': Key.PageUp,
            'pagedown': Key.PageDown,
            'f1': Key.F1,
            'f2': Key.F2,
            'f3': Key.F3,
            'f4': Key.F4,
            'f5': Key.F5,
            'f6': Key.F6,
            'f7': Key.F7,
            'f8': Key.F8,
            'f9': Key.F9,
            'f10': Key.F10,
            'f11': Key.F11,
            'f12': Key.F12
        };

        // Convert keys to nut.js Key constants
        const mappedKeys = keyArray.map(key => {
            const trimmedKey = key.trim();
            if (keyMap[trimmedKey]) {
                return keyMap[trimmedKey];
            }
            // For single characters, return as string
            return trimmedKey;
        });

        console.log(`🎹 Pressing key combination: ${keys} -> ${mappedKeys.map(k => k.name || k).join(' + ')}`);

        // Press all keys together as combination
        await keyboard.pressKey(...mappedKeys);

        return `pressed ${keys}`;
    },

    key_repeat: async ({ key, count, times, repeats, repeat, n }) => {
        const resolvedCount = count ?? times ?? repeats ?? repeat ?? n;
        const pressCount = Math.max(1, parseInt(resolvedCount, 10) || 1);
        const keyLower = key.toLowerCase();
        const keyMap = {
            'space': Key.Space,
            'enter': Key.Return,
            'return': Key.Return,
            'tab': Key.Tab,
            'escape': Key.Escape,
            'esc': Key.Escape,
            'backspace': Key.BackSpace,
            'delete': Key.Delete,
            'up': Key.Up,
            'down': Key.Down,
            'left': Key.Left,
            'right': Key.Right,
            'pageup': Key.PageUp,
            'pagedown': Key.PageDown
        };
        const mappedKey = keyMap[keyLower] || key;
        for (let i = 0; i < pressCount; i++) {
            await keyboard.pressKey(mappedKey);
            await new Promise(r => setTimeout(r, 50));
        }
        return `pressed ${key} x${pressCount}`;
    },

    key_combo_repeat: async ({ keys, count, times, repeats, repeat, n }) => {
        const resolvedCount = count ?? times ?? repeats ?? repeat ?? n;
        const pressCount = Math.max(1, parseInt(resolvedCount, 10) || 1);
        for (let i = 0; i < pressCount; i++) {
            await tools.key_combo({ keys });
            await new Promise(r => setTimeout(r, 50));
        }
        return `pressed ${keys} x${pressCount}`;
    },

    enter: async () => {
        await keyboard.pressKey(Key.Return);
        return "pressed enter";
    },

    tab: async () => {
        await keyboard.pressKey(Key.Tab);
        return "pressed tab";
    },

    escape: async () => {
        await keyboard.pressKey(Key.Escape);
        return "pressed escape";
    },

    backspace: async () => {
        await keyboard.pressKey(Key.BackSpace);
        return "pressed backspace";
    },

    space: async () => {
        await keyboard.pressKey(Key.Space);
        return "pressed space";
    },

    get_screen_size: async () => {
        const width = await screen.width();
        const height = await screen.height();
        return { width, height };
    },

    notify: async ({ title, message }) => {
        try {
            if (!title || !message) {
                return "error: title and message required";
            }
            console.log(`🔔 Notification: ${title} - ${message}`);
            const safeTitle = String(title).replace(/"/g, '\\"').replace(/\$/g, '\\$');
            const safeMessage = String(message).replace(/"/g, '\\"').replace(/\$/g, '\\$');
            execFileSync("osascript", ["-e", `display notification "${safeMessage}" with title "${safeTitle}"`]);
            return "notification sent";
        } catch (e) {
            console.error("Notify Error:", e.message);
            return "failed to notify";
        }
    },

    find_shortcuts: async ({ app_name, intention }) => {
        console.log(`🔍 Looking up shortcut for "${intention}" in "${app_name}"...`);
        const shortcut = await queryShortcut(app_name, intention);

        if (shortcut && shortcut !== "null") {
            console.log(`✅ Found Shortcut: ${shortcut}`);
            return `FOUND: ${shortcut}`;
        } else {
            console.log("❌ No shortcut found.");
            return "NOT_FOUND";
        }
    },

    list_shortcuts: async ({ app_name }) => {
        if (!app_name) return "error: app_name required";
        const list = await listShortcuts(app_name);
        return list;
    },

    // 📁 FILE OPERATIONS
    file_operation: async ({ type, path: filepath, name }) => {
        try {
            if (type === 'create_folder') {
                const expandedPath = filepath.replace('~', os.homedir());
                if (!fs.existsSync(expandedPath)) {
                    fs.mkdirSync(expandedPath, { recursive: true });
                    console.log(`✅ Folder created: ${expandedPath}`);
                    return `created folder: ${expandedPath}`;
                } else {
                    console.log(`ℹ️ Folder already exists: ${expandedPath}`);
                    return `folder already exists: ${expandedPath}`;
                }
            } else if (type === 'delete_file') {
                const expandedPath = filepath.replace('~', os.homedir());
                if (fs.existsSync(expandedPath)) {
                    fs.unlinkSync(expandedPath);
                    console.log(`✅ File deleted: ${expandedPath}`);
                    return `deleted file: ${expandedPath}`;
                } else {
                    return `file not found: ${expandedPath}`;
                }
            } else if (type === 'list_files') {
                const expandedPath = filepath.replace('~', os.homedir());
                const files = fs.readdirSync(expandedPath);
                console.log(`📋 Files in ${expandedPath}:`, files);
                return `found ${files.length} files: ${files.join(', ')}`;
            }
            return "unknown file operation";
        } catch (e) {
            console.error("File Operation Error:", e.message);
            return `failed: ${e.message}`;
        }
    },

    // 🖥️ APP SWITCHING
    switch_app: async ({ app_name }) => {
        try {
            console.log(`🔄 Switching to ${app_name}...`);
            const script = `activate application "${app_name}"`;
            execFileSync('osascript', ['-e', script]);
            console.log(`✅ Switched to ${app_name}`);
            return `switched to ${app_name}`;
        } catch (e) {
            console.error("App Switch Error:", e.message);
            return `failed to switch: ${e.message}`;
        }
    },

    // 🎬 APPLESCRIPT EXECUTION
    execute_script: async ({ script, type }) => {
        try {
            if (type !== 'applescript' && type !== 'shell') {
                return `error: type must be 'applescript' or 'shell'`;
            }
            
            console.log(`⚙️ Executing ${type}: ${script.substring(0, 50)}...`);
            const result = execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
            console.log(`✅ Script executed`);
            return `executed: ${result.trim()}`;
        } catch (e) {
            console.error("Script Execution Error:", e.message);
            return `failed: ${e.message}`;
        }
    },

    // ⏱️ CONDITIONAL WAIT
    wait_for: async ({ condition, timeout, app_name, text }) => {
        try {
            const timeoutMs = timeout || 5000;
            const startTime = Date.now();
            
            console.log(`⏳ Waiting for condition: ${condition} (${timeoutMs}ms timeout)...`);
            
            if (condition === 'app_visible') {
                // Check if app window is visible
                const script = `tell application "System Events"
                    return (exists window of application "${app_name}")
                end tell`;
                
                while (Date.now() - startTime < timeoutMs) {
                    try {
                        const result = execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
                        if (result.includes('true')) {
                console.log(`✅ App "${app_name}" is now visible`);
                            return `app visible: ${app_name}`;
                        }
                    } catch (e) {
                        // App not visible yet
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return `timeout: app "${app_name}" not visible after ${timeoutMs}ms`;
            }
            
            return `unknown condition: ${condition}`;
        } catch (e) {
            console.error("Wait Error:", e.message);
            return `failed: ${e.message}`;
        }
    },


    // 🖥️ OPEN APP - Terminal: open -a "AppName"
    open_app: async ({ app_name }) => {
        try {
            if (!app_name) return "error: app_name required";
            console.log(`🚀 Opening app: ${app_name}`);
            const { execSync } = require('child_process');
            execSync(`open -a "${app_name}"`, { stdio: 'pipe' });
            console.log(`✅ Opened: ${app_name}`);
            return `app_opened: ${app_name}`;
        } catch (e) {
            console.error("Open App Error:", e.message);
            return `failed: ${e.message}`;
        }
    },

    // 🔍 MDFIND - Terminal: mdfind query
    mdfind: async ({ query, type }) => {
        try {
            if (!query) return "error: query required";
            console.log(`🔎 Searching with mdfind: ${query}`);
            const { execSync } = require('child_process');
            let cmd = `mdfind "${query}"`;
            if (type === 'apps') {
                cmd = `mdfind "kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '*${query}*'"`;
            }
            const result = execSync(cmd, { encoding: 'utf-8' });
            const lines = result.trim().split('\n');
            console.log(`✅ Found ${lines.length} results`);
            return `search_results: ${lines.slice(0, 5).join(', ')}`;
        } catch (e) {
            console.error("mdfind Error:", e.message);
            return `failed: ${e.message}`;
        }
    },

    // 🌐 OPEN URL - Terminal: open "url"
    open_url: async ({ url }) => {
        try {
            if (!url) return "error: url required";
            if (!url.startsWith('http')) {
                url = 'https://' + url;
            }
            console.log(`🌐 Opening URL: ${url}`);
            const { execSync } = require('child_process');
            execSync(`open "${url}"`, { stdio: 'pipe' });
            console.log(`✅ Opened in browser: ${url}`);
            return `url_opened: ${url}`;
        } catch (e) {
            console.error("Open URL Error:", e.message);
            return `failed: ${e.message}`;
        }
    },

    chrome_eval: async ({ script }) => {
        if (!script || typeof script !== "string") return "error: script required";
        const result = runChromeFrontTabJS(script);
        return result;
    },

    chrome_tab_hygiene: async ({ keep } = {}) => {
        const keepN = Math.max(1, Math.min(3, parseInt(keep, 10) || 2));
        try {
            const appleScript = `tell application "Google Chrome"
if (count of windows) is 0 then return "no_windows"
set w to front window
set tcount to (count of tabs of w)
repeat while tcount > ${keepN}
  try
    close (tab 1 of w)
  end try
  set tcount to (count of tabs of w)
end repeat
return "ok:" & tcount
end tell`;
            const res = runAppleScript(appleScript);
            return res || "ok";
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    chrome_set_url: async ({ url } = {}) => {
        const u = ensureHttpUrl(url);
        if (!u) return "error: url required";
        try {
            const escaped = escapeAppleScriptString(u);
            const appleScript = `tell application "Google Chrome"
activate
if (count of windows) is 0 then make new window
set URL of active tab of front window to "${escaped}"
return URL of active tab of front window
end tell`;
            const res = runAppleScript(appleScript);
            return res || "ok";
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    chrome_get_dom: async ({ max_chars } = {}) => {
        const maxChars = Math.max(500, Math.min(40000, parseInt(max_chars, 10) || 12000));
        const script = `(function(){try{
  const html=String(document.documentElement && document.documentElement.outerHTML || "");
  const out=html.length>${maxChars} ? html.slice(0,${maxChars}) : html;
  return JSON.stringify({ok:true,url:location.href,title:String(document.title||""),html:out,truncated:html.length>${maxChars}});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_get_dom_element: async ({ selector }) => {
        const sel = String(selector || "").trim();
        if (!sel) return "error: selector required";
        const script = `(function(){try{
  const sel=${JSON.stringify(sel)};
  const el=document.querySelector(sel);
  if(!el) return JSON.stringify({ok:false,error:"not_found",selector:sel});
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const tag=String(el.tagName||"").toLowerCase();
  const role=norm(el.getAttribute&&el.getAttribute("role"));
  const aria=norm(el.getAttribute&&el.getAttribute("aria-label"));
  const href=norm(el.getAttribute&&el.getAttribute("href"));
  const type=norm(el.getAttribute&&el.getAttribute("type"));
  const txt=norm(el.innerText||el.value||"");
  return JSON.stringify({ok:true,selector:sel,element:{tag,role,ariaLabel:aria,href,type,text:txt}});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err),selector:${JSON.stringify(sel)}});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    youtube_get_transcript: async ({ max_chars } = {}) => {
        const maxChars = Math.max(500, Math.min(20000, parseInt(max_chars, 10) || 6000));
        const script = `(async function(){try{
  const max=${maxChars};
  const getPR=()=>window.ytInitialPlayerResponse||window.ytplayer?.config?.args?.player_response&&JSON.parse(window.ytplayer.config.args.player_response)||null;
  const pr=getPR();
  if(!pr) return JSON.stringify({ok:false,error:"no_player_response"});
  const tracks=pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks||[];
  if(!tracks.length) return JSON.stringify({ok:false,error:"no_caption_tracks"});
  const url=String(tracks[0]?.baseUrl||"");
  if(!url) return JSON.stringify({ok:false,error:"no_caption_url"});
  const resp=await fetch(url);
  const xml=await resp.text();
  const decode=(s)=>String(s||"")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,"\\\"")
    .replace(/&#39;/g,"'");
  const texts=[...xml.matchAll(/<text[^>]*>([\\s\\S]*?)<\\/text>/g)].map(m=>decode(m[1])
    .replace(/<[^>]+>/g,"")
    .replace(/\\s+/g," ")
    .trim()).filter(Boolean);
  let joined=texts.join("\\n");
  if(joined.length>max) joined=joined.slice(0,max);
  return JSON.stringify({ok:true,url:location.href,caption_url:url,text:joined,truncated:joined.length>=max});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    youtube_post_comment: async ({ text } = {}) => {
        const value = String(text || "").trim();
        if (!value) return "error: text required";
        const script = `(function(){try{
  const val=${JSON.stringify(value)};
  // Fast unavailable/private detection
  const bodyTxt=String(document.body && document.body.innerText || "").slice(0,5000);
  if(/video unavailable|this video is private|private video|has been removed|is unavailable|is not available|isn't available/i.test(bodyTxt) || /video unavailable/i.test(String(document.title||""))){
    return JSON.stringify({ok:false,error:"video_unavailable_or_private"});
  }
  // Scroll comments into view
  const comments=document.querySelector("ytd-comments")||document.querySelector("#comments");
  if(comments && comments.scrollIntoView) comments.scrollIntoView({block:"start"});
  // Open the comment box
  const placeholder=document.querySelector("ytd-comment-simplebox-renderer #placeholder-area") ||
    document.querySelector("#placeholder-area");
  if(placeholder) placeholder.click();
  const box=document.querySelector("ytd-comment-simplebox-renderer #contenteditable-root") ||
    document.querySelector("#contenteditable-root");
  if(!box) return JSON.stringify({ok:false,error:"comment_box_not_found"});
  box.focus();
  box.textContent=val;
  box.dispatchEvent(new Event("input",{bubbles:true}));
  // Click submit
  const btn=document.querySelector("ytd-comment-simplebox-renderer #submit-button button") ||
    document.querySelector("#submit-button button") ||
    document.querySelector("ytd-comment-simplebox-renderer ytd-button-renderer#submit-button button");
  if(!btn) return JSON.stringify({ok:false,error:"submit_button_not_found"});
  btn.click();
  return JSON.stringify({ok:true,submitted:true});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        if (parsed.ok !== true) return `error: youtube_post_comment ${String(parsed.error || "unknown_error")}`;
        if (parsed.submitted !== true) return "error: youtube_post_comment not_submitted";
        return "youtube_comment_submitted";
    },

    youtube_confirm_comment: async ({ text, timeout_ms } = {}) => {
        const needle = String(text || "").trim();
        const timeoutMs = Math.max(500, Math.min(15000, parseInt(timeout_ms, 10) || 6000));
        const start = Date.now();

        const probeScript = `(function(){try{
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const toastEl=document.querySelector("tp-yt-paper-toast#toast") || document.querySelector("tp-yt-paper-toast");
  const toastTxt=toastEl?norm(toastEl.innerText||toastEl.textContent||""):"";
  const toastOk=/comment\\s+(added|posted)/i.test(toastTxt);

  const bodyTxt=String(document.body && document.body.innerText || "").slice(0,5000);
  if(/video unavailable|this video is private|private video|has been removed|is unavailable|is not available|isn't available/i.test(bodyTxt) || /video unavailable/i.test(String(document.title||""))){
    return JSON.stringify({ok:false,error:"video_unavailable_or_private"});
  }

  let found=false;
  const needle=${JSON.stringify(needle)};
  if(needle){
    const max=30;
    const nodes=[...document.querySelectorAll("ytd-comment-thread-renderer #content-text, ytd-comment-renderer #content-text")].slice(0,max);
    for(const n of nodes){
      const t=norm(n && n.innerText || "");
      if(t && t.includes(needle)){ found=true; break; }
    }
  }
  return JSON.stringify({ok:true,toast_ok:toastOk,toast_text:toastTxt.slice(0,120),found});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

        while (Date.now() - start < timeoutMs) {
            const raw = runChromeFrontTabJS(probeScript);
            const parsed = tryParseJson(raw);
            if (parsed && parsed.ok === false && parsed.error === "video_unavailable_or_private") {
                return "error: youtube_video_unavailable_or_private";
            }
            if (parsed && parsed.ok === true) {
                if (parsed.toast_ok === true) return "youtube_comment_confirmed_toast";
                if (needle && parsed.found === true) return "youtube_comment_confirmed_dom";
            }
            await new Promise(r => setTimeout(r, 300));
        }

        return "youtube_comment_unconfirmed";
    },

    youtube_get_status: async () => {
        const script = `(function(){try{
  const title=String(document.title||"");
  const path=String(location.pathname||"");
  const isWatch=(path==="/watch" || path.startsWith("/shorts/"));
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  if(!isWatch){
    return JSON.stringify({ok:true,url:location.href,title,available:false,reason:"not_watch_page",is_watch:false});
  }
  const errorNode =
    document.querySelector("ytd-player-error-message-renderer") ||
    document.querySelector(".ytp-error") ||
    document.querySelector("#error-screen");
  const errorText = norm(errorNode && (errorNode.innerText || errorNode.textContent) || "");
  const hasWatchHeader = !!document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h1 yt-formatted-string");
  const hardUnavailable =
    /this video is private|video unavailable|private video|has been removed|is unavailable|is not available|isn't available/i.test(errorText) ||
    (/video unavailable/i.test(title) && !hasWatchHeader);
  const reasonMatch = errorText.match(/(this video is private|video unavailable|private video|has been removed|is unavailable|is not available|isn't available)/i);
  return JSON.stringify({ok:true,url:location.href,title,available:!hardUnavailable,reason:reasonMatch?reasonMatch[1]:"",is_watch:true});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    youtube_get_video_meta: async () => {
        const script = `(function(){try{
  const norm=(s)=>String(s||"").replace(/\\s+/g," ").trim();
  const url=String(location.href||"");
  const titleEl=document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
    document.querySelector("h1.title yt-formatted-string") ||
    document.querySelector("h1 yt-formatted-string");
  const channelEl=document.querySelector("#channel-name a") ||
    document.querySelector("ytd-channel-name a") ||
    document.querySelector("#text-container.ytd-channel-name a");
  const descEl=document.querySelector("#description") ||
    document.querySelector("ytd-text-inline-expander #snippet") ||
    document.querySelector("ytd-watch-metadata #description");
  const metaDesc=document.querySelector('meta[name=\"description\"]');
  const title=norm((titleEl && titleEl.textContent) || String(document.title||"").replace(/\\s*-\\s*YouTube\\s*$/i,""));
  const channel=norm((channelEl && channelEl.textContent) || "");
  const description=norm((descEl && descEl.innerText) || (metaDesc && metaDesc.getAttribute && metaDesc.getAttribute("content")) || "");
  const path=String(location.pathname||"");
  const isWatch=path==="/watch" || path.startsWith("/shorts/");
  const vid=(function(){
    try{
      const u=new URL(url);
      const v=u.searchParams.get("v");
      if(v) return v;
      if(path.startsWith("/shorts/")) return path.split("/shorts/")[1].split(/[?#/]/)[0];
    }catch(e){}
    return "";
  })();
  return JSON.stringify({ok:true,url,title,channel,description:description.slice(0,1200),is_watch:isWatch,video_id:vid});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    youtube_search: async ({ query, max_results } = {}) => {
        const q = String(query || "").trim();
        const maxResults = Math.max(1, Math.min(20, parseInt(max_results, 10) || 10));
        if (!q) return "error: query required";

        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        // Reuse the current front tab instead of opening new tabs.
        try {
            const escaped = escapeAppleScriptString(url);
            const appleScript = `tell application "Google Chrome"
activate
if (count of windows) is 0 then make new window
set URL of active tab of front window to "${escaped}"
return "ok"
end tell`;
            runAppleScript(appleScript);
        } catch (e) {
            // Fallback: open once (may create a new tab)
            try {
                execFileSync("bash", ["-lc", `open -a "Google Chrome" "${url}"`], { stdio: "pipe" });
            } catch (e2) {
                return `error: ${e2.message}`;
            }
        }

        try {
            if (!global.chromeJsDisabled && tools.chrome_wait) {
                await tools.chrome_wait({
                    predicate_js: "document.readyState === 'complete' || document.readyState === 'interactive'",
                    timeout_ms: 12000,
                    interval_ms: 250
                });
            } else {
                await sleep(1000);
            }
        } catch {}

        const extractScript = `(function(){try{
  const norm=(s)=>String(s||"").replace(/\\s+/g," ").trim();
  const out=[];
  const nodes=[...document.querySelectorAll("ytd-video-renderer,ytd-reel-item-renderer")].slice(0,40);
  for(const n of nodes){
    const a=n.querySelector("#video-title");
    const href=String((a && (a.href || a.getAttribute && a.getAttribute('href'))) || "");
    if(!href) continue;
    let full=href;
    if(full.startsWith("/")) full="https://www.youtube.com"+full;
    if(!/\\/watch\\?v=|\\/shorts\\//.test(full)) continue;
    const title=norm(a && a.textContent);
    const chA=n.querySelector("ytd-channel-name a") || n.querySelector("#channel-name a");
    const channel=norm(chA && chA.textContent);
    if(!title) continue;
    out.push({title,url:full,channel});
  }
  // Dedup by url
  const seen=new Set();
  const uniq=[];
  for(const r of out){
    if(seen.has(r.url)) continue;
    seen.add(r.url);
    uniq.push(r);
  }
  return JSON.stringify({ok:true,url:location.href,results:uniq});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

        const merged = [];
        const seen = new Set();
        for (let pass = 0; pass < 4; pass++) {
            const raw = runChromeFrontTabJS(extractScript);
            const parsed = tryParseJson(raw);
            if (parsed && parsed.ok === true && Array.isArray(parsed.results)) {
                for (const r of parsed.results) {
                    const u = String(r?.url || "");
                    if (!u || seen.has(u)) continue;
                    seen.add(u);
                    merged.push({ title: r.title, url: u, channel: r.channel });
                    if (merged.length >= maxResults) break;
                }
                if (merged.length >= maxResults) break;
            }

            // Scroll to load more results.
            runChromeFrontTabJS(`(function(){try{window.scrollBy(0, 2600);}catch(e){} return "ok";})()`);
            await sleep(700);
        }

        return JSON.stringify({ ok: true, query: q, results: merged.slice(0, maxResults) });
    },

    chrome_get_context: async () => {
        const script = `(function(){try{
  const ae=document.activeElement;
  const safe=(v)=>String(v||"").replace(/\\s+/g," ").trim();
  const info=ae?{
    tag:safe(ae.tagName).toLowerCase(),
    role:safe(ae.getAttribute&&ae.getAttribute("role")),
    ariaLabel:safe(ae.getAttribute&&ae.getAttribute("aria-label")),
    placeholder:safe(ae.getAttribute&&ae.getAttribute("placeholder")),
    type:safe(ae.getAttribute&&ae.getAttribute("type")),
    name:safe(ae.getAttribute&&ae.getAttribute("name")),
    id:safe(ae.id),
    className:safe(ae.className)
  }:null;
  const txt=safe(document.body && document.body.innerText);
  const loggedOutHint = /log in|login|sign up|create account/i.test(txt.slice(0,3000));
  return JSON.stringify({ok:true,url:location.href,title:safe(document.title),readyState:document.readyState,active:info,loggedOutHint});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_list: async (params = {}) => {
        const maxResults = Math.max(1, Math.min(50, parseInt(params.max_results, 10) || 12));
        const selector = String(params.selector || "");
        const role = String(params.role || "");
        const name = String(params.name || "");
        const text = String(params.text || "");
        const hrefContains = String(params.href_contains || "");
        const type = String(params.type || "");

        const script = `(function(){try{
  const params=${JSON.stringify({ selector, role, name, text, hrefContains, type, maxResults })};
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const lower=s=>norm(s).toLowerCase();
  const wantRole=lower(params.role);
  const wantName=lower(params.name);
  const wantText=lower(params.text);
  const wantHref=lower(params.hrefContains);
  const wantType=lower(params.type);

  const baseSel = params.selector && params.selector.length
    ? params.selector
    : 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';

  const nodes=[...document.querySelectorAll(baseSel)];
  const visible=nodes.filter(el=>{try{const r=el.getBoundingClientRect();return r.width>1&&r.height>1&&r.bottom>0&&r.right>0;}catch(e){return false;}});
  const items=[];
  for(const el of visible){
    const tag=String(el.tagName||"").toLowerCase();
    const roleAttr=String(el.getAttribute&&el.getAttribute("role")||"").toLowerCase();
    const aria=norm(el.getAttribute&&el.getAttribute("aria-label")||"");
    const ph=norm(el.getAttribute&&el.getAttribute("placeholder")||"");
    const href=String(el.getAttribute&&el.getAttribute("href")||"");
    const typeAttr=String(el.getAttribute&&el.getAttribute("type")||"").toLowerCase();
    const ce=String(el.getAttribute&&el.getAttribute("contenteditable")||"").toLowerCase()==="true";
    const effRole = roleAttr || (tag==="a"?"link":(tag==="button"?"button":((tag==="input"||tag==="textarea"||ce)?"textbox":"")));
    const txt=norm(el.innerText||el.value||"");
    const label=aria||txt||ph||href;
    const hay=(lower(label)+" "+lower(txt)+" "+lower(ph)+" "+lower(href)+" "+tag+" "+effRole);

    if(wantRole && effRole!==wantRole) continue;
    if(wantType && typeAttr!==wantType) continue;
    if(wantName && !hay.includes(wantName)) continue;
    if(wantText && !hay.includes(wantText)) continue;
    if(wantHref && !lower(href).includes(wantHref)) continue;

    items.push({tag,role:effRole,ariaLabel:aria,placeholder:ph,text:txt,href,type:typeAttr});
    if(items.length>=params.maxResults) break;
  }
  return JSON.stringify({ok:true,count:items.length,items});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_click: async (params = {}) => {
        const index = Math.max(1, parseInt(params.index, 10) || 1);
        const dryRun = params.dry_run === true;
        const maxResults = Math.max(12, Math.min(50, parseInt(params.max_results, 10) || 12));

        const selector = params.selector || "";
        const role = params.role || "";
        const name = params.name || "";
        const text = params.text || "";
        const hrefContains = params.href_contains || "";
        const type = params.type || "";

        const script = `(function(){try{
  const params=${JSON.stringify({ selector, role, name, text, hrefContains, type })};
  const idx=${index};
  const dry=${dryRun ? "true" : "false"};
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const lower=s=>norm(s).toLowerCase();
  const wantRole=lower(params.role);
  const wantName=lower(params.name);
  const wantText=lower(params.text);
  const wantHref=lower(params.hrefContains);
  const wantType=lower(params.type);

  const baseSel = params.selector && params.selector.length
    ? params.selector
    : 'a,button,[role=\"button\"],[role=\"link\"],input[type=\"button\"],input[type=\"submit\"]';

  const nodes=[...document.querySelectorAll(baseSel)];
  const visible=nodes.filter(el=>{try{const r=el.getBoundingClientRect();return r.width>1&&r.height>1&&r.bottom>0&&r.right>0;}catch{return false;}});
  const matches=[];
  for(const el of visible){
    const tag=String(el.tagName||\"\").toLowerCase();
    const role=String(el.getAttribute&&el.getAttribute(\"role\")||\"\").toLowerCase();
    const aria=norm(el.getAttribute&&el.getAttribute(\"aria-label\")||\"\");
    const href=String(el.getAttribute&&el.getAttribute(\"href\")||\"\");
    const type=String(el.getAttribute&&el.getAttribute(\"type\")||\"\").toLowerCase();
    const effRole = role || (tag===\"a\"?\"link\":(tag===\"button\"?\"button\":((tag===\"input\"||tag===\"textarea\")?\"textbox\":\"\")));
    const txt=norm(el.innerText||el.value||\"\");
    const label=aria||txt||href;
    const hay=(lower(label)+\" \"+lower(txt)+\" \"+lower(href)+\" \"+tag+\" \"+role);
    if(wantRole && effRole!==wantRole) continue;
    if(wantType && type!==wantType) continue;
    if(wantName && !hay.includes(wantName)) continue;
    if(wantText && !hay.includes(wantText)) continue;
    if(wantHref && !lower(href).includes(wantHref)) continue;
    matches.push({el,tag,role:effRole,ariaLabel:aria,text:txt,href,type});
    if(matches.length>=${maxResults}) break;
  }
  if(!matches.length) return JSON.stringify({ok:false,error:\"no_matches\"});
  const picked=matches[Math.min(idx-1,matches.length-1)];
  if(dry){
    return JSON.stringify({ok:true,count:matches.length,items:matches.map(m=>({tag:m.tag,role:m.role,ariaLabel:m.ariaLabel,text:m.text,href:m.href,type:m.type}))});
  }
  try{picked.el.scrollIntoView({block:\"center\",inline:\"center\"});}catch{}
  try{picked.el.click();}catch{picked.el.dispatchEvent(new MouseEvent(\"click\",{bubbles:true,cancelable:true,view:window}));}
  return JSON.stringify({ok:true,clicked:{tag:picked.tag,role:picked.role,ariaLabel:picked.ariaLabel,text:picked.text,href:picked.href,type:picked.type}});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_focus: async (params = {}) => {
        const index = Math.max(1, parseInt(params.index, 10) || 1);
        const selector = String(params.selector || 'input,textarea,select,[role="textbox"],[contenteditable="true"]');
        const name = String(params.name || params.text || "");
        const script = `(function(){try{
  const idx=${index};
  const baseSel=${JSON.stringify(selector)};
  const want=${JSON.stringify(name)}.toLowerCase();
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const nodes=[...document.querySelectorAll(baseSel)];
  const visible=nodes.filter(el=>{try{const r=el.getBoundingClientRect();return r.width>1&&r.height>1&&r.bottom>0&&r.right>0;}catch{return false;}});
  const matches=[];
  for(const el of visible){
    const tag=String(el.tagName||"").toLowerCase();
    const role=String(el.getAttribute&&el.getAttribute("role")||"").toLowerCase();
    const aria=norm(el.getAttribute&&el.getAttribute("aria-label")||"");
    const ph=norm(el.getAttribute&&el.getAttribute("placeholder")||"");
    const id=norm(el.id||"");
    const cls=norm(el.className||"");
    const hay=(aria+" "+ph+" "+id+" "+cls).toLowerCase();
    const effRole = role || ((tag==="input"||tag==="textarea") ? "textbox" : "");
    if(want && !hay.includes(want)) continue;
    matches.push({el,tag,role:effRole,ariaLabel:aria,placeholder:ph});
  }
  if(!matches.length) return JSON.stringify({ok:false,error:"no_matches"});
  const picked=matches[Math.min(idx-1,matches.length-1)];
  try{picked.el.scrollIntoView({block:"center",inline:"center"});}catch{}
  try{picked.el.click();}catch{}
  try{picked.el.focus();}catch{}
  return JSON.stringify({ok:true,focused:{tag:picked.tag,role:picked.role,ariaLabel:picked.ariaLabel,placeholder:picked.placeholder}});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_type: async ({ text, mode, selector, name } = {}) => {
        const value = String(text || "");
        if (!value) return "error: text required";
        const method = String(mode || "dom").toLowerCase();
        if (method === "keyboard") {
            await keyboard.type(value);
            return "typed: keyboard";
        }
        // Optional: focus a target element first when caller provides selector/name.
        if (selector || name) {
            // Use DOM script directly for focus (mirrors chrome_focus).
            try {
                const idx = 1;
                const baseSel = String(selector || 'input,textarea,[role="textbox"],[contenteditable="true"]');
                const want = String(name || "").toLowerCase();
                const focusScript = `(function(){try{
  const idx=${idx};
  const baseSel=${JSON.stringify(baseSel)};
  const want=${JSON.stringify(want)};
  const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
  const nodes=[...document.querySelectorAll(baseSel)];
  const visible=nodes.filter(el=>{try{const r=el.getBoundingClientRect();return r.width>1&&r.height>1&&r.bottom>0&&r.right>0;}catch{return false;}});
  const matches=[];
  for(const el of visible){
    const tag=String(el.tagName||"").toLowerCase();
    const role=String(el.getAttribute&&el.getAttribute("role")||"").toLowerCase();
    const aria=norm(el.getAttribute&&el.getAttribute("aria-label")||"");
    const ph=norm(el.getAttribute&&el.getAttribute("placeholder")||"");
    const id=norm(el.id||"");
    const cls=norm(el.className||"");
    const hay=(aria+" "+ph+" "+id+" "+cls).toLowerCase();
    if(want && !hay.includes(want)) continue;
    matches.push(el);
  }
  const picked=matches[Math.min(idx-1,matches.length-1)];
  if(!picked) return JSON.stringify({ok:false,error:"no_matches"});
  try{picked.scrollIntoView({block:"center",inline:"center"});}catch{}
  try{picked.click();}catch{}
  try{picked.focus&&picked.focus();}catch{}
  return JSON.stringify({ok:true});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
                runChromeFrontTabJS(focusScript);
                await sleep(80);
            } catch {}
        }
        const script = `(function(){try{
  const v=${JSON.stringify(value)};
  const el=document.activeElement;
  if(!el) return JSON.stringify({ok:false,error:"no_active_element"});
  const tag=String(el.tagName||"").toLowerCase();
  const ce=String(el.getAttribute&&el.getAttribute("contenteditable")||"").toLowerCase()==="true";
  const role=String(el.getAttribute&&el.getAttribute("role")||"").toLowerCase();
  const isText=(tag==="textarea"||tag==="input"||role==="textbox"||ce);
  if(!isText) return JSON.stringify({ok:false,error:"active_not_text",tag,role});
  if(tag==="input"||tag==="textarea"){
    el.value=v;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
  } else {
    el.textContent=v;
    el.dispatchEvent(new Event("input",{bubbles:true}));
  }
  return JSON.stringify({ok:true,tag,role});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_extract: async ({ selector, max_chars } = {}) => {
        const maxChars = Math.max(200, Math.min(20000, parseInt(max_chars, 10) || 6000));
        const sel = selector ? String(selector) : "";
        const script = `(function(){try{
  const max=${maxChars};
  let txt="";
  if(${sel ? "true" : "false"}){
    const el=document.querySelector(${JSON.stringify(sel)});
    if(el) txt=String(el.innerText||el.textContent||"");
  } else {
    txt=String(document.body && document.body.innerText || "");
  }
  txt=txt.replace(/\\s+/g," ").trim();
  if(txt.length>max) txt=txt.slice(0,max);
  return JSON.stringify({ok:true,text:txt});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
        const raw = runChromeFrontTabJS(script);
        const parsed = tryParseJson(raw);
        if (!parsed) return `error: ${raw}`;
        return JSON.stringify(parsed);
    },

    chrome_wait: async ({ predicate_js, timeout_ms, interval_ms } = {}) => {
        const timeoutMs = Math.max(500, Math.min(60000, parseInt(timeout_ms, 10) || 8000));
        const intervalMs = Math.max(100, Math.min(2000, parseInt(interval_ms, 10) || 300));
        const pred = String(predicate_js || "").trim();
        if (!pred) return "error: predicate_js required";
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            const raw = runChromeFrontTabJS(`(function(){try{return JSON.stringify({ok:true,value:Boolean(${pred})});}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)});}})();`);
            const parsed = tryParseJson(raw);
            if (parsed && parsed.ok === true && parsed.value === true) return "ok: predicate_true";
            await sleep(intervalMs);
        }
        return `timeout: predicate not true after ${timeoutMs}ms`;
    },

    instagram_open_post: async ({ username, index_from_latest, include_pinned }) => {
        try {
            const index = Math.max(1, parseInt(index_from_latest, 10) || 1);
            const includePinned = include_pinned === true;
            const cleanUser = String(username || "").replace(/^@/, "").trim();

            if (cleanUser) {
                // Do not force-navigate the browser here; the caller controls navigation.
                // This avoids loops where we keep reopening the profile page every iteration.
                // If the caller wants navigation, it should use open_url/shell first.
                await sleep(50);
            }

            const script = `(function(){try{
  const idx=${index};
  const includePinned=${includePinned ? "true" : "false"};
  const path=String(location.pathname||"");
  // If we're already on a post/reel, navigate to the profile before picking "latest".
  if((path.startsWith("/p/")||path.startsWith("/reel/"))){
    const u=${JSON.stringify(cleanUser)};
    if(u){
      const href="https://www.instagram.com/"+u+"/";
      location.href=href;
      return JSON.stringify({ok:true,navigating:true,href});
    }
  }

  // IG frequently changes DOM. Prefer robust link harvesting from main/feed.
  const rawAnchors=[...document.querySelectorAll('a[href]')];
  const anchors=rawAnchors.filter(a=>{
    const h=a.getAttribute('href')||"";
    // Profile-grid links look like /<user>/p/<id>/ or /<user>/reel/<id>/
    return h.includes("/p/") || h.includes("/reel/");
  });
  const seen=new Set();
  const ordered=[];
  const isPinned=(a)=>{
    // Best-effort pinned detection; may not exist in current DOM.
    const c=a.closest('article, main, div');
    if(!c) return false;
    return !!c.querySelector('svg[aria-label*="Pinned"],svg[aria-label*="pinned"],svg[title*="Pinned"],svg[title*="pinned"]');
  };
  for(const a of anchors){
    const href=a.getAttribute('href');
    if(!href||seen.has(href)) continue;
    seen.add(href);
    ordered.push({a,href,pinned:isPinned(a)});
  }
  // Heuristic: on profile pages, the first /p/ link is usually the most recent in grid.
  let candidates=includePinned?ordered:ordered.filter(x=>!x.pinned);
  if(!candidates.length) candidates=ordered;
  if(!candidates.length) return JSON.stringify({ok:false,error:"no_posts_found",debug:{path,links:rawAnchors.length}});
  const target=candidates[Math.min(idx-1,candidates.length-1)];
  target.a.scrollIntoView({block:"center",inline:"center"});
  try{target.a.click();}catch{target.a.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));}
  return JSON.stringify({ok:true,href:target.href,index:idx,total:candidates.length,pinned:target.pinned});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
            const raw = runChromeFrontTabJS(script);
            const parsed = extractJsonObject(raw);
            if (!parsed || parsed.ok !== true) {
                return `error: instagram_open_post failed (${raw})`;
            }
            if (parsed.navigating) {
                return `instagram_profile_opened: ${parsed.href || "unknown"}`;
            }
            return `instagram_post_opened: ${parsed.href || "unknown"}`;
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    instagram_navigate_post: async ({ direction, steps }) => {
        try {
            const dir = String(direction || "right").toLowerCase() === "left" ? "left" : "right";
            const count = Math.max(1, parseInt(steps, 10) || 1);
            const script = `(function(){try{const dir="${dir}";const steps=${count};const labels=dir==="right"?["Next","Next post","Go to next"]:["Previous","Previous post","Go back","Back"];let moved=0;for(let i=0;i<steps;i++){const btn=[...document.querySelectorAll('button')].find(b=>{const a=(b.getAttribute("aria-label")||"").toLowerCase();return labels.some(l=>a.includes(l.toLowerCase()));});if(btn){btn.click();moved++;continue;}const k=dir==="right"?"ArrowRight":"ArrowLeft";document.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true}));moved++;}return JSON.stringify({ok:true,moved});}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
            const raw = runChromeFrontTabJS(script);
            const parsed = extractJsonObject(raw);
            if (!parsed || parsed.ok !== true) return `error: instagram_navigate_post failed (${raw})`;
            return `instagram_navigated_${dir}: ${parsed.moved}`;
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    instagram_focus_comment: async () => {
        try {
            const checkFocusedScript = `(function(){try{
  const ae=document.activeElement;
  const tag=String(ae&&ae.tagName||"").toLowerCase();
  const role=String(ae&&ae.getAttribute&&ae.getAttribute("role")||"").toLowerCase();
  const ce=String(ae&&ae.getAttribute&&ae.getAttribute("contenteditable")||"").toLowerCase();
  const label=((ae&&ae.getAttribute&&ae.getAttribute("aria-label"))||"")+" "+((ae&&ae.getAttribute&&ae.getAttribute("placeholder"))||"");
  const isTextTarget=(tag==="textarea"||role==="textbox"||ce==="true");
  const isCommentLike=String(label).toLowerCase().includes("comment");
  const path=String(location&&location.pathname||"");
  return JSON.stringify({ok:true,focused:Boolean(isTextTarget&&(isCommentLike||path.includes('/p/')||path.includes('/reel/'))),tag,role,ce,label,path});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

            // DOM-first: click a "Comment" button (if present) to reveal input, then focus the best candidate textbox.
            const focusDomScript = `(function(){try{
  const path=String(location&&location.pathname||"");
  // If we're not on a post/reel, focusing comment is unlikely to be valid.
  if(!(path.includes('/p/')||path.includes('/reel/'))){
    return JSON.stringify({ok:false,error:"not_on_post",path});
  }

  const isVisible=(el)=>{if(!el) return false; const r=el.getBoundingClientRect(); return r.width>4&&r.height>4&&r.bottom>0&&r.right>0&&r.top<(window.innerHeight||0)&&r.left<(window.innerWidth||0);};

  const btns=[...document.querySelectorAll('button,[role=\"button\"]')];
  const commentBtn=btns.find(b=>{
    const a=String(b.getAttribute&&b.getAttribute('aria-label')||'').toLowerCase();
    const t=String(b.innerText||'').toLowerCase();
    return (a.includes('comment')||t==='comment') && isVisible(b);
  });
  if(commentBtn){ try{commentBtn.click();}catch{} }

  const candidates=[...document.querySelectorAll('textarea,div[role=\"textbox\"],[contenteditable=\"true\"]')].filter(isVisible);
  const scored=candidates.map(el=>{
    const s=((el.getAttribute('aria-label')||'')+' '+(el.getAttribute('placeholder')||'')+' '+(el.id||'')+' '+(el.className||'')).toLowerCase();
    const score=(s.includes('add a comment')?20:0)+(s.includes('comment')?10:0)+(s.includes('reply')?4:0);
    return {el,score,s};
  }).sort((a,b)=>b.score-a.score);
  const target=(scored[0]&&scored[0].el)||candidates[0]||null;
  if(target){
    target.scrollIntoView({block:'center',inline:'center'});
    try{target.click();}catch{}
    try{target.focus&&target.focus();}catch{}
  }
  return JSON.stringify({ok:true,attempted:Boolean(target),found:candidates.length,score:(scored[0]&&scored[0].score)||0});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

            const isFocused = () => {
                const raw = runChromeFrontTabJS(checkFocusedScript);
                const parsed = extractJsonObject(raw);
                return Boolean(parsed && parsed.ok === true && parsed.focused === true);
            };

            runChromeFrontTabJS(focusDomScript);
            await sleep(120);
            if (isFocused()) return "comment_focus_ready: dom";

            return "comment_focus_not_confirmed";
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    instagram_post_comment: async ({ text } = {}) => {
        try {
            const comment = String(text || "").trim();
            if (!comment) return "error: instagram_post_comment requires non-empty text";

            const script = `(function(){try{
  const path=String(location&&location.pathname||"");
  if(!(path.includes('/p/')||path.includes('/reel/'))){
    return JSON.stringify({ok:false,error:"not_on_post",path});
  }

  const isVisible=(el)=>{if(!el) return false; const r=el.getBoundingClientRect(); return r.width>4&&r.height>4&&r.bottom>0&&r.right>0&&r.top<(window.innerHeight||0)&&r.left<(window.innerWidth||0);};

  // Ensure comment UI is present
  const btns=[...document.querySelectorAll('button,[role=\"button\"]')];
  const commentBtn=btns.find(b=>{
    const a=String(b.getAttribute&&b.getAttribute('aria-label')||'').toLowerCase();
    const t=String(b.innerText||'').toLowerCase();
    return (a.includes('comment')||t==='comment') && isVisible(b);
  });
  if(commentBtn){ try{commentBtn.click();}catch{} }

  const candidates=[...document.querySelectorAll('textarea,div[role=\"textbox\"],[contenteditable=\"true\"]')].filter(isVisible);
  const scored=candidates.map(el=>{
    const s=((el.getAttribute('aria-label')||'')+' '+(el.getAttribute('placeholder')||'')+' '+(el.id||'')+' '+(el.className||'')).toLowerCase();
    const score=(s.includes('add a comment')?20:0)+(s.includes('comment')?10:0)+(s.includes('reply')?4:0);
    return {el,score,s};
  }).sort((a,b)=>b.score-a.score);
  const target=(scored[0]&&scored[0].el)||candidates[0]||null;
  if(!target) return JSON.stringify({ok:false,error:"no_comment_box_found",found:0});

  target.scrollIntoView({block:'center',inline:'center'});
  try{target.click();}catch{}
  try{target.focus&&target.focus();}catch{}

  const setText=(el,txt)=>{
    const tag=String(el.tagName||'').toLowerCase();
    const role=String(el.getAttribute&&el.getAttribute('role')||'').toLowerCase();
    const ce=String(el.getAttribute&&el.getAttribute('contenteditable')||'').toLowerCase();
    const fireInput=(node)=>{
      try{
        if(typeof InputEvent!=='undefined'){
          node.dispatchEvent(new InputEvent('input',{bubbles:true,data:txt,inputType:'insertText'}));
        } else {
          node.dispatchEvent(new Event('input',{bubbles:true}));
        }
      }catch{ try{node.dispatchEvent(new Event('input',{bubbles:true}));}catch{} }
      try{node.dispatchEvent(new Event('change',{bubbles:true}));}catch{}
    };
    if(tag==='textarea' || tag==='input'){
      el.value=txt;
      fireInput(el);
      return {mode:'value'};
    }
    if(role==='textbox' || ce==='true'){
      el.textContent=txt;
      fireInput(el);
      return {mode:'textContent'};
    }
    return {mode:'unknown'};
  };
  const setRes=setText(target, ${JSON.stringify(comment)});

  // Find "Post" button. Re-query after typing because IG enables/disables dynamically.
  const btns2=[...document.querySelectorAll('button,[role=\"button\"]')];
  const postBtn = btns2.find(b=>{
    if(!isVisible(b)) return false;
    const a=String(b.getAttribute&&b.getAttribute('aria-label')||'').toLowerCase();
    const t=String(b.innerText||'').trim().toLowerCase();
    if(t==='post' || a==='post' || a.includes('post')) return true;
    return false;
  }) || null;
  if(!postBtn){
    return JSON.stringify({ok:false,error:"no_post_button_found",set:setRes});
  }
  try{postBtn.click();}catch(e){return JSON.stringify({ok:false,error:"post_click_failed:"+String(e&&e.message||e),set:setRes});}

  return JSON.stringify({ok:true,set:setRes,clicked:true});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

            const raw = runChromeFrontTabJS(script);
            const parsed = extractJsonObject(raw);
            if (!parsed || parsed.ok !== true) return `error: instagram_post_comment failed (${raw})`;
            return "instagram_comment_posted";
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    instagram_get_post_caption: async () => {
        try {
            const script = `(function(){try{const candidates=[...document.querySelectorAll('article h1, article ul li span, article div[role="dialog"] h1, article div[role="dialog"] span')].map(n=>String(n.innerText||"").trim()).filter(Boolean);let caption="";for(const t of candidates){if(t.length>caption.length)caption=t;}return JSON.stringify({ok:true,caption});}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;
            const raw = runChromeFrontTabJS(script);
            const parsed = extractJsonObject(raw);
            if (!parsed || parsed.ok !== true) return `error: instagram_get_post_caption failed (${raw})`;
            const caption = String(parsed.caption || "").replace(/\s+/g, " ").trim();
            return caption ? `caption: ${caption}` : "caption: ";
        } catch (e) {
            return `error: ${e.message}`;
        }
    },

    // 🔍 SPOTLIGHT SEARCH VIA OSASCRIPT (Terminal-based)

    // 🔍 SPOTLIGHT SEARCH VIA CLIPBOARD + PASTE (More Reliable)
    spotlight_search: async ({ query }) => {
        try {
            if (!query || typeof query !== 'string') {
                return "error: query must be a non-empty string";
            }
            console.log(`🔍 Opening Spotlight and searching for: ${query}`);
            
            // Step 1: Copy query to clipboard
            execFileSync('bash', ['-c', `echo "${query}" | pbcopy`]);
            
            // Step 2: Open Spotlight (Cmd+Space)
            execFileSync('osascript', ['-e', 'tell application "System Events" to key code 49 using command down']);
            
            // Step 3: Short delay for Spotlight UI to render
            await new Promise(r => setTimeout(r, 200));
            
            // Step 4: Paste query (Cmd+V)
            execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
            
            return `searched for ${query} in Spotlight`;
        } catch (e) {
            console.error("Spotlight Search Error:", e.message);
            return `failed: ${e.message}`;
        }
    }
};

export default tools;
