import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";
import tools from "./tools.mjs";
import memory from "./memory.mjs";

dotenv.config();

let _aiClient = null;
let _aiKey = null;
function getAi() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is missing");
    if (!_aiClient || _aiKey !== key) {
        _aiClient = new GoogleGenAI({ apiKey: key });
        _aiKey = key;
    }
    return _aiClient;
}

const VALIDATOR_MODEL = "gemini-3-flash-preview";

function parseRetryDelayMsFromError(err) {
    const msg = String(err?.message || err || "");
    // Try JSON payload embedded in message
    try {
        const parsed = JSON.parse(msg);
        const retryInfo = parsed?.error?.details?.find((d) => String(d?.["@type"] || "").includes("RetryInfo"));
        const delay = retryInfo?.retryDelay || parsed?.error?.details?.find((d) => d?.retryDelay)?.retryDelay;
        if (typeof delay === "string" && delay.endsWith("s")) {
            const s = parseFloat(delay.slice(0, -1));
            if (Number.isFinite(s) && s > 0) return Math.min(120000, Math.ceil(s * 1000));
        }
    } catch {}

    // Try "Please retry in 34.01s"
    const m = msg.match(/retry in\s+([0-9.]+)s/i);
    if (m) {
        const s = parseFloat(m[1]);
        if (Number.isFinite(s) && s > 0) return Math.min(120000, Math.ceil(s * 1000));
    }
    return 0;
}

function isGeminiRateLimitError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return (
        msg.includes("resource_exhausted") ||
        msg.includes("quota exceeded") ||
        msg.includes("rate limit") ||
        msg.includes("429") ||
        msg.includes("retry in")
    );
}

function setGeminiCooldown(ms) {
    const now = Date.now();
    const until = now + Math.max(0, ms | 0);
    global.geminiCooldownUntil = Math.max(global.geminiCooldownUntil || 0, until);
}

function parseShellOsascriptKeyMacro(command = "") {
    const cmd = String(command || "");
    if (!cmd.includes("osascript")) return null;
    if (!cmd.includes("System Events") && !cmd.includes("System Events\"")) return null;
    if (!cmd.includes("key code") && !cmd.includes("keystroke")) return null;

    const keyCodeToKey = {
        48: "tab",
        36: "enter",
        51: "backspace",
        49: "space",
        123: "left",
        124: "right",
        125: "down",
        126: "up"
    };

    const steps = [];

    // Example planner macro:
    // ... repeat 18 times ... key code 48 ... end repeat ... key code 36
    const repeatMatch = cmd.match(/repeat\s+(\d+)\s+times[\s\S]*?key code\s+(\d+)/i);
    if (repeatMatch) {
        const count = Math.max(1, parseInt(repeatMatch[1], 10) || 1);
        const code = parseInt(repeatMatch[2], 10);
        const key = keyCodeToKey[code];
        if (key) {
            if (key === "enter") {
                steps.push({ action: "key", args: { key: "enter" } });
            } else {
                steps.push({ action: "key_repeat", args: { key, count } });
            }
        }
    }

    // If macro ends with Enter, include it as a follow-up step when not already captured.
    if (cmd.match(/key code\s+36\b/i)) {
        const last = steps[steps.length - 1];
        const alreadyHasEnter = last && (last.action === "enter" || (last.action === "key" && String(last.args?.key || "").toLowerCase() === "enter"));
        if (!alreadyHasEnter) steps.push({ action: "key", args: { key: "enter" } });
    }

    return steps.length ? steps : null;
}

function parseShellChromeAppleScriptJs(command = "") {
    // Detect shell commands that try to run Chrome JavaScript via osascript.
    // Example:
    // osascript -e 'tell application "Google Chrome" to execute active tab of window 1 javascript "document.links[0].click()"'
    const cmd = String(command || "");
    const lower = cmd.toLowerCase();
    if (!lower.includes("osascript")) return null;
    if (!lower.includes("tell application") || !lower.includes("google chrome")) return null;
    if (!lower.includes("javascript")) return null;

    const normalized = cmd
        .replace(/[’‘]/g, "'")
        .replace(/\\\\\"/g, '"')
        .replace(/\\"/g, '"');
    const m = normalized.match(/javascript\\s+\"([\\s\\S]*?)\"/i);
    if (!m) return null;
    const js = m[1]
        .replace(/\\\\\"/g, "\"")
        .replace(/\\\\n/g, "\n")
        .trim();
    if (!js) return null;
    return js;
}

async function validateTaskCompletion(goal, lastAction, lastResult, screenshotBase64 = null) {
    try {
        const g = String(goal || "").toLowerCase();
        const actionName = String(lastAction?.action || "").toLowerCase();
        const resultStr = String(lastResult || "");
        const resultJson = extractJSON(resultStr);
        const resultLooksOk = !(
            /^(error|failed)\b/i.test(resultStr) ||
            (resultJson && resultJson.ok === false) ||
            (resultJson && resultJson.available === false)
        );
        const looksMultiStep = /\b(and|then|after|before|comment|click|type|fill|search|navigate|follow|unfollow|like|share|download|upload|save|rename|extract)\b/i.test(g);

        // Fast-path heuristics to reduce validator calls and prevent obvious loops.
        // These are generic (not test-case specific).
        if (resultLooksOk) {
            if (actionName === "shell") {
                const cmd = String(lastAction?.args?.command || "");
                if (!looksMultiStep &&
                    (g.includes("create a folder") || g.includes("create folder") || g.includes("make a folder") || g.includes("mkdir") || g.includes("directory") || g.includes("folder")) &&
                    /\bmkdir\b/.test(cmd)) {
                    return { done: true, needs_user_input: false, question: "" };
                }
                if (!looksMultiStep &&
                    (g.startsWith("open ") || g.includes("open chrome") || g.includes("open google chrome")) &&
                    /\bopen\s+-a\s+\"?google chrome\"?/i.test(cmd)) {
                    return { done: true, needs_user_input: false, question: "" };
                }
                if (!looksMultiStep && g.startsWith("open ") && /\bopen\s+https?:\/\//i.test(cmd)) {
                    return { done: true, needs_user_input: false, question: "" };
                }
            }
            if (actionName === "open_url") {
                if (!looksMultiStep && (g.startsWith("open ") || g.includes("open url") || g.includes("open website"))) {
                    return { done: true, needs_user_input: false, question: "" };
                }
            }
            if (actionName === "gemini_extract_text" || actionName === "extract_text") {
                if (!looksMultiStep && g.includes("extract") && (g.includes("text") || g.includes("ocr"))) {
                    return { done: true, needs_user_input: false, question: "" };
                }
            }
        }

        const prompt = `You are a task completion validator.
Decide if the user's goal is fully completed.
Return JSON only: {"done": true|false, "needs_user_input": true|false, "question": "..." }

USER GOAL: ${goal}
LAST ACTION: ${JSON.stringify(lastAction)}
LAST RESULT: ${lastResult}

Rules:
- Ask user only for hard blockers (credentials not available, OTP/CAPTCHA, explicit user choice with no inferable default).
- Do NOT ask user for "positive comment" content if goal already implies sentiment; the agent can draft one.
- If screenshot indicates logged-in state or actionable UI, continue without asking login confirmation.
- If the page indicates "video unavailable/private/removed" (or similar), done=false and needs_user_input=true with a clear question for next steps.
- If the goal has multiple steps remaining, done=false.
- If the goal is satisfied, done=true.`;

        const parts = [{ text: prompt }];
        if (screenshotBase64) {
            parts.push({
                inlineData: {
                    mimeType: "image/png",
                    data: screenshotBase64
                }
            });
        }

        let response = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                response = await getAi().models.generateContent({
                    model: VALIDATOR_MODEL,
                    contents: [{ role: "user", parts }]
                });
                break;
            } catch (e) {
                if (isGeminiRateLimitError(e)) {
                    const delay = parseRetryDelayMsFromError(e) || (1500 * attempt);
                    setGeminiCooldown(delay);
                    if (attempt === 3) throw e;
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                const msg = String(e?.message || "");
                const overloaded = msg.toLowerCase().includes("overloaded") || msg.includes("503");
                if (!overloaded || attempt === 3) throw e;
                await new Promise(r => setTimeout(r, 800 * attempt));
            }
        }

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const jsonStr = text.replace(/```json/g, "").replace(/```/g, "").trim();
        try {
            const data = JSON.parse(jsonStr);
            return data;
        } catch {
            return { done: false, needs_user_input: false, question: "" };
        }
    } catch (e) {
        console.error("Validator error:", e.message);
        return { done: false, needs_user_input: false, question: "" };
    }
}

function needsClarification(goal = "") {
    const g = goal.toLowerCase();
    if (g.includes("user input:")) return null;

    // Playlist ambiguity
    if (g.includes("playlist")) {
        const hasNamed = /playlist\s+(named|called)\s+/i.test(goal) || /playlist\s+\".+\"/i.test(goal) || /\".+\"/.test(goal);
        if (!hasNamed) {
            return "Which playlist should I play? Reply with the playlist name.";
        }
    }

    // Form filling ambiguity
    if (g.includes("fill") && g.includes("form")) {
        return "I need missing details (e.g., age, address, ID number). You can also provide a document name or path to extract from.";
    }

    // Document extraction intent
    if (g.includes("aadhaar") || g.includes("aadhar") || g.includes("passport") || g.includes("id card")) {
        return "Please provide the document name or path to extract details from.";
    }

    return null;
}

function extractFilePathFromText(text) {
    const pathRegex = /(~\/[^\s]+|\/[^\s]+\.(pdf|png|jpg|jpeg|heic|tiff|bmp|gif))/i;
    const match = text.match(pathRegex);
    return match ? match[1].trim() : null;
}

async function extractFieldsFromText(docText) {
    try {
        const prompt = `Extract structured fields from the following document text.
Return JSON ONLY with common form fields if present (name, dob, age, address, id_number, email, phone, gender, nationality).
If a field is missing, omit it.
TEXT:
${docText}
`;
        const response = await getAi().models.generateContent({
            model: VALIDATOR_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const jsonStr = text.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("Field extraction error:", e.message);
        return {};
    }
}

function shouldUseDocs(goal = "") {
    const g = goal.toLowerCase();
    return (
        g.includes("aadhaar") ||
        g.includes("aadhar") ||
        g.includes("passport") ||
        g.includes("id card") ||
        g.includes("document") ||
        (g.includes("fill") && g.includes("form"))
    );
}

async function handleDocumentExtraction(goal) {
    if (!shouldUseDocs(goal)) return { goal, asked: false };

    // If we already asked and user replied with a number
        if (global.pendingDocChoices && /user input:\s*\d+/i.test(goal)) {
            const num = parseInt(goal.match(/user input:\s*(\d+)/i)?.[1] || "0", 10);
            const chosen = global.pendingDocChoices[num - 1];
            global.pendingDocChoices = null;
            if (chosen) {
                const text = await tools.gemini_extract_text({ file_path: chosen });
                if (!String(text).startsWith("error")) {
                    const snippet = String(text).slice(0, 2000);
                    const fields = await extractFieldsFromText(snippet);
                    return { goal: `${goal}\n\nEXTRACTED_DOCUMENT_TEXT:\n${snippet}\n\nEXTRACTED_FIELDS_JSON:\n${JSON.stringify(fields)}`, asked: false };
                }
            }
        }

    const path = extractFilePathFromText(goal);
    if (path) {
        const text = await tools.gemini_extract_text({ file_path: path });
        if (!String(text).startsWith("error")) {
            const snippet = String(text).slice(0, 2000);
            const fields = await extractFieldsFromText(snippet);
            return { goal: `${goal}\n\nEXTRACTED_DOCUMENT_TEXT:\n${snippet}\n\nEXTRACTED_FIELDS_JSON:\n${JSON.stringify(fields)}`, asked: false };
        }
    }

    // Try to find candidates by name
    const query = (goal.match(/user input:\s*(.+)/i)?.[1] || "aadhaar").trim();
    const results = await tools.find_candidate_docs({ query, max_results: 10 });
    if (typeof results === "string" && results.startsWith("results:")) {
        const list = results.split("\n").slice(1).filter(Boolean);
        if (list.length === 1) {
            const text = await tools.gemini_extract_text({ file_path: list[0] });
            if (!String(text).startsWith("error")) {
                const snippet = String(text).slice(0, 2000);
                const fields = await extractFieldsFromText(snippet);
                return { goal: `${goal}\n\nEXTRACTED_DOCUMENT_TEXT:\n${snippet}\n\nEXTRACTED_FIELDS_JSON:\n${JSON.stringify(fields)}`, asked: false };
            }
        }

        if (list.length > 1) {
            global.pendingDocChoices = list;
            const numbered = list.map((p, i) => `${i + 1}. ${p}`).join("\n");
            return {
                goal,
                asked: true,
                question: `I found multiple documents. Reply with the number to use:\n${numbered}`
            };
        }
    }

    return { goal, asked: false };
}



// ============================================================================
// 🧠 MULTI-MODEL SYSTEM (RAG + HYDE + HELPER + Validator + Executor)
// ============================================================================

// 1️⃣ RAG ENHANCER - Enhance user query with retrieval context
async function ragEnhancer(userGoal, screenshot) {
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const model = ai.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const result = await model.generateContent({
            contents: [{
                parts: [{
                    text: `Context: User wants to: "${userGoal}"
Current screenshot shows: [system state]
Provide: Enhanced goal description with specific details, app names, expected outcomes.
Be concise. Return only the enhanced goal.`
                }]
            }]
        });

        return result.response.text().trim();
    } catch (e) {
        console.error("RAG Enhancer Error:", e.message);
        return userGoal;
    }
}

// 2️⃣ HYDE - Generate hypothetical examples of success
async function hydeExamples(userGoal) {
    try {
        const response = await retryWithBackoff(async () => {
            return await getAi().models.generateContent({
                model: (CONFIG && CONFIG.HYDE_MODEL_NAME) || "gemini-3-flash-preview",
                contents: [{
                    role: "user",
                    parts: [{
                        text: `Goal: ${userGoal}
Generate 3 hypothetical successful action sequences that would achieve this.
Format: action_name → action_name → result
Keep it brief.`
                    }]
                }]
            });
        });
        const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return String(text).trim();
    } catch (e) {
        console.error("HYDE Error:", e.message);
        return "";
    }
}

function helperList(value, maxItems = 6) {
    if (!Array.isArray(value)) return [];
    const cleaned = [];
    for (const item of value) {
        const t = String(item || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        cleaned.push(t.slice(0, 220));
        if (cleaned.length >= maxItems) break;
    }
    return cleaned;
}

function helperString(value, maxChars = 260) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function normalizeHelperArtifact(value) {
    if (typeof value === "string") {
        const name = helperString(value, 64);
        if (!name) return null;
        return { name, status: "unknown", source: "unknown", detail: "" };
    }
    if (!value || typeof value !== "object") return null;
    const name = helperString(value.name || value.artifact || value.item || value.key || "", 64);
    if (!name) return null;
    const statusRaw = helperString(value.status || value.state || value.readiness || "unknown", 24).toLowerCase();
    const source = helperString(value.source || value.from || "unknown", 24).toLowerCase();
    const detail = helperString(value.detail || value.reason || value.notes || "", 180);
    const statusAllowed = new Set(["present", "missing", "optional", "required", "blocked", "ready", "not_needed", "unknown"]);
    const status = statusAllowed.has(statusRaw) ? statusRaw : "unknown";
    return { name, status, source: source || "unknown", detail };
}

function normalizeHelperAnalysis(raw = {}) {
    const contextRaw = String(raw.context_importance || raw.context_priority || raw.context_level || "medium").toLowerCase();
    const contextImportance = ["low", "medium", "high"].includes(contextRaw) ? contextRaw : "medium";
    const mustAskUser = Boolean(raw.must_ask_user || raw.needs_clarification || raw.ask_user);
    const intentTypeRaw = helperString(raw.intent_type || raw.task_type || raw.mode || "unknown", 40).toLowerCase();
    const intentType = intentTypeRaw || "unknown";
    const artifactsRaw = Array.isArray(raw.required_artifacts)
        ? raw.required_artifacts
        : Array.isArray(raw.requiredArtifacts)
            ? raw.requiredArtifacts
            : [];
    const requiredArtifacts = artifactsRaw.map(normalizeHelperArtifact).filter(Boolean).slice(0, 8);
    let question = "";
    if (mustAskUser) {
        question = helperString(raw.question || raw.question_to_ask || raw.clarifying_question || "", 220);
        if (!question) {
            const missing = helperList(raw.missing_facts || raw.missing_context || raw.missing_inputs, 1)[0];
            question = missing ? `Please provide: ${missing}` : "Please provide the missing detail needed to continue.";
        }
    }

    return {
        mustAskUser,
        question,
        intentType,
        contextImportance,
        taskUnderstanding: helperString(raw.task_understanding || raw.goal_decode || raw.summary || "", 260),
        knownFacts: helperList(raw.known_facts || raw.facts || raw.confirmed_context),
        missingFacts: helperList(raw.missing_facts || raw.missing_context || raw.missing_inputs),
        constraints: helperList(raw.constraints || raw.guardrails || raw.limits),
        riskChecks: helperList(raw.risk_checks || raw.risks || raw.validation_checks),
        nextStrategy: helperList(raw.next_strategy || raw.strategy_steps || raw.execution_outline),
        plannerHints: helperList(raw.planner_hints || raw.hints || raw.strategy_hints),
        preferredTools: helperList(raw.preferred_tools || raw.tool_suggestions),
        avoidTools: helperList(raw.avoid_tools || raw.blocked_tools),
        requiredArtifacts
    };
}

function buildHelperPlannerContext(helper = null) {
    if (!helper) return "";
    const lines = [];
    lines.push("HELPER_THINKING_ANALYSIS:");
    if (helper.taskUnderstanding) lines.push(`- Task decode: ${helper.taskUnderstanding}`);
    if (helper.intentType && helper.intentType !== "unknown") lines.push(`- Intent type: ${helper.intentType}`);
    lines.push(`- Context importance: ${helper.contextImportance}`);
    if (helper.knownFacts.length) lines.push(`- Known facts: ${helper.knownFacts.join(" | ")}`);
    if (helper.missingFacts.length) lines.push(`- Missing facts: ${helper.missingFacts.join(" | ")}`);
    if (helper.constraints.length) lines.push(`- Constraints: ${helper.constraints.join(" | ")}`);
    if (helper.riskChecks.length) lines.push(`- Risk checks: ${helper.riskChecks.join(" | ")}`);
    if (helper.nextStrategy.length) lines.push(`- Next strategy: ${helper.nextStrategy.join(" | ")}`);
    if (helper.requiredArtifacts.length) {
        const artifactText = helper.requiredArtifacts
            .slice(0, 6)
            .map((a) => `${a.name}:${a.status}${a.source && a.source !== "unknown" ? `@${a.source}` : ""}`)
            .join(" | ");
        lines.push(`- Required artifacts: ${artifactText}`);
    }
    if (helper.plannerHints.length) lines.push(`- Planner hints: ${helper.plannerHints.join(" | ")}`);
    if (helper.preferredTools.length) lines.push(`- Preferred tools: ${helper.preferredTools.join(", ")}`);
    if (helper.avoidTools.length) lines.push(`- Avoid tools: ${helper.avoidTools.join(", ")}`);
    if (helper.hydeExamples) lines.push(`- HYDE examples: ${helperString(helper.hydeExamples, 700)}`);
    const context = lines.join("\n");
    return context.length > 2600 ? context.slice(0, 2600) : context;
}

function shouldLogHelperTrace() {
    return Boolean(CONFIG?.HELPER_DEBUG_LOGS);
}

function helperTraceSignature(stage = "", goal = "", helper = null) {
    const g = helperString(goal, 120);
    const ask = helper?.mustAskUser ? "1" : "0";
    const q = helperString(helper?.question || "", 120);
    const c = helperString(helper?.contextImportance || "", 12);
    const missing = helperList(helper?.missingFacts || [], 2).join("|");
    const artifacts = (helper?.requiredArtifacts || [])
        .slice(0, 2)
        .map((a) => `${helperString(a?.name || "", 24)}:${helperString(a?.status || "", 12)}`)
        .join("|");
    return `${stage}::${g}::${ask}::${c}::${q}::${missing}::${artifacts}`;
}

function logHelperTrace(stage = "", userGoal = "", runContext = "", hydeText = "", helper = null, fromCache = false) {
    if (!shouldLogHelperTrace()) return;
    const sig = helperTraceSignature(stage, userGoal, helper);
    global.helperTraceState = global.helperTraceState || Object.create(null);
    if (fromCache && global.helperTraceState[stage] === sig) return;
    global.helperTraceState[stage] = sig;

    const maxChars = Math.max(200, Math.min(2000, parseInt(CONFIG?.HELPER_TRACE_MAX_CHARS, 10) || 700));
    const plannerContext = String(helper?.plannerContext || "");
    const plannerShort = plannerContext.length > maxChars ? `${plannerContext.slice(0, maxChars)}...` : plannerContext;
    const goalShort = helperString(userGoal, 180);
    const hydeShort = helperString(hydeText, 220);
    const contextShort = helperString(runContext, 180);
    const missing = helperList(helper?.missingFacts || [], 4);
    const hints = helperList(helper?.plannerHints || [], 4);
    const artifacts = (helper?.requiredArtifacts || [])
        .slice(0, 5)
        .map((a) => `${a.name}:${a.status}${a.source && a.source !== "unknown" ? `@${a.source}` : ""}`);

    console.log(`🧩 HELPER [${stage}] ${fromCache ? "cache" : "fresh"} | ask_user=${helper?.mustAskUser ? "yes" : "no"} | context=${helper?.contextImportance || "medium"} | goal="${goalShort}"`);
    if (helper?.question) console.log(`🧩 HELPER [${stage}] question: ${helper.question}`);
    if (helper?.intentType && helper.intentType !== "unknown") console.log(`🧩 HELPER [${stage}] intent: ${helper.intentType}`);
    if (missing.length) console.log(`🧩 HELPER [${stage}] missing: ${missing.join(" | ")}`);
    if (artifacts.length) console.log(`🧩 HELPER [${stage}] artifacts: ${artifacts.join(" | ")}`);
    if (hints.length) console.log(`🧩 HELPER [${stage}] planner_hints: ${hints.join(" | ")}`);
    if (hydeShort) console.log(`🧩 HELPER [${stage}] hyde: ${hydeShort}`);
    if (contextShort) console.log(`🧩 HELPER [${stage}] run_context: ${contextShort}`);
    if (plannerShort) console.log(`🧩 HELPER [${stage}] planner_context: ${plannerShort}`);
}

function compactRecentActionsForHelper(history = [], maxItems = 6) {
    if (!Array.isArray(history) || history.length === 0) return "none";
    return history
        .slice(-maxItems)
        .map((a) => {
            const action = helperString(a?.action || "", 40);
            const args = helperString(JSON.stringify(a?.args || {}), 140);
            return `${action} ${args}`;
        })
        .join("\n");
}

// 3️⃣ HELPER THINKING MODEL - Decodes missing context before planning
async function helperThinkingModel(userGoal, hydeText = "", runContext = "", recentActions = []) {
    try {
        const response = await retryWithBackoff(async () => {
            return await getAi().models.generateContent({
                model: (CONFIG && CONFIG.HELPER_MODEL_NAME) || "gemini-3-flash-preview",
                contents: [{
                    role: "user",
                    parts: [{
                        text: `You are HELPER, the non-executing reasoning model that runs BEFORE the planner.
Your role is to think deeply, decompose ambiguity, and provide high-quality context to the planner.

Core behavior:
- Think capability-first, not hardcoded case-first.
- Do NOT output coordinates.
- Do NOT lock into a single URL unless already verified.
- Prefer tool-capability reasoning (status checks, transcript extraction, DOM verification, memory context).
- Ask user only for hard blockers that cannot be resolved with available tools.

Return JSON only with this schema:
{
  "must_ask_user": true|false,
  "question": "single concise blocker question when must_ask_user=true, else empty",
  "intent_type": "open|navigate|comment|extract|download|multi_step|unknown",
  "context_importance": "low|medium|high",
  "task_understanding": "1-2 lines",
  "known_facts": ["..."],
  "missing_facts": ["..."],
  "constraints": ["..."],
  "risk_checks": ["..."],
  "next_strategy": ["high-level ordered steps"],
  "required_artifacts": [
    {"name":"artifact_name","status":"present|missing|optional|required|not_needed|unknown","source":"goal|memory|transcript|dom|user|unknown","detail":"optional"}
  ],
  "planner_hints": ["..."],
  "preferred_tools": ["..."],
  "avoid_tools": ["..."]
}

Example 1:
Input goal: "Open PewDiePie's latest video."
Output:
{"must_ask_user":false,"question":"","intent_type":"open","context_importance":"low","task_understanding":"Open latest matching public YouTube video.","known_facts":["Target creator: PewDiePie"],"missing_facts":[],"constraints":["Prefer public playable video"],"risk_checks":["Avoid private/unavailable links"],"next_strategy":["Resolve target video","Open URL","Verify watch page"],"required_artifacts":[{"name":"target_video_url","status":"missing","source":"dom","detail":"resolve from channel/search"}],"planner_hints":["Use YouTube status verification before finalizing"],"preferred_tools":["youtube_get_status","youtube_get_video_meta","youtube_search"],"avoid_tools":["literal coordinate navigation"]}

Example 2:
Input goal: "Comment on latest Linux video by PewDiePie and include a quote from the video."
Output:
{"must_ask_user":false,"question":"","intent_type":"comment","context_importance":"high","task_understanding":"Need final comment text plus quote from transcript after video is open.","known_facts":["Target topic: Linux","Target creator: PewDiePie"],"missing_facts":["Quote text"],"constraints":["Comment should be relevant","Quote should come from transcript/video content"],"risk_checks":["Verify video is playable","Verify comment box exists"],"next_strategy":["Resolve/open target video","Extract quote from transcript","Compose and submit comment"],"required_artifacts":[{"name":"comment_text","status":"present","source":"goal","detail":"provided or generated"},{"name":"video_quote","status":"missing","source":"transcript","detail":"extract after watch page is loaded"}],"planner_hints":["Do not ask for quote before trying transcript extraction"],"preferred_tools":["youtube_get_transcript","youtube_post_comment","youtube_confirm_comment"],"avoid_tools":["hardcoded quote strings"]}

Example 3:
Input goal: "Open first vlog and comment."
Output:
{"must_ask_user":false,"question":"","intent_type":"multi_step","context_importance":"high","task_understanding":"Find earliest vlog, verify availability, then comment.","known_facts":[],"missing_facts":["May need fallback if first is unavailable"],"constraints":["Handle unavailable/private explicitly"],"risk_checks":["Check availability before comment submit"],"next_strategy":["Resolve earliest vlog","If unavailable ask user for next option","Else proceed to comment"],"required_artifacts":[{"name":"target_video_url","status":"missing","source":"dom","detail":"earliest vlog candidate"}],"planner_hints":["If unavailable/private, ask a focused follow-up with options"],"preferred_tools":["youtube_get_status","youtube_search"],"avoid_tools":["assuming first candidate is playable"]}

Now analyze the CURRENT TASK below.

GOAL:
${userGoal}

HYDE EXAMPLES:
${hydeText || "none"}

RUN CONTEXT:
${runContext || "none"}

RECENT ACTIONS:
${compactRecentActionsForHelper(recentActions)}`
                    }]
                }]
            });
        });

        const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = extractJSON(String(text)) || {};
        const normalized = normalizeHelperAnalysis(parsed);
        normalized.hydeExamples = helperString(hydeText, 900);
        return normalized;
    } catch (e) {
        console.error("Helper Thinking Error:", e.message);
        return {
            mustAskUser: false,
            question: "",
            contextImportance: "medium",
            taskUnderstanding: "",
            knownFacts: [],
            missingFacts: [],
            constraints: [],
            plannerHints: [],
            preferredTools: [],
            avoidTools: [],
            hydeExamples: helperString(hydeText, 900)
        };
    }
}

async function getHelperThinkingContext(userGoal, runContext, runState, options = {}) {
    const stage = String(options?.stage || "runtime");
    runState.cache = runState.cache || Object.create(null);
    const now = Date.now();
    const normalizedGoal = helperString(userGoal, 2000).toLowerCase();
    const normalizedContext = helperString(runContext, 1200).toLowerCase();

    let hydeText = "";
    const hydeCached = runState.cache.hydeResult || null;
    if (
        hydeCached &&
        hydeCached.goal === normalizedGoal &&
        (now - hydeCached.ts) < (CONFIG.HYDE_CACHE_TTL_MS || 60000)
    ) {
        hydeText = String(hydeCached.text || "");
    } else {
        hydeText = await hydeExamples(userGoal);
        runState.cache.hydeResult = { goal: normalizedGoal, text: hydeText, ts: now };
    }

    const helperKey = `${normalizedGoal}::${normalizedContext}`;
    const helperCached = runState.cache.helperThinking || null;
    if (
        helperCached &&
        helperCached.key === helperKey &&
        (now - helperCached.ts) < (CONFIG.HELPER_CACHE_TTL_MS || 15000)
    ) {
        logHelperTrace(stage, userGoal, runContext, hydeText, helperCached.value, true);
        return helperCached.value;
    }

    const helper = await helperThinkingModel(userGoal, hydeText, runContext, actionHistory);
    const plannerContext = buildHelperPlannerContext(helper);
    const value = { ...helper, plannerContext };
    runState.cache.helperThinking = { key: helperKey, value, ts: now };
    logHelperTrace(stage, userGoal, runContext, hydeText, value, false);
    return value;
}

// 4️⃣ SHORTCUT ADVISOR - Dedicated model for keyboard shortcuts
async function shortcutAdvisor(appName, intention) {
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const model = ai.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const result = await model.generateContent({
            contents: [{
                parts: [{
                    text: `App: ${appName}
Intent: ${intention}
Return ONLY the Mac keyboard shortcut (e.g. cmd+s, cmd+t, opt+cmd+j)
If no standard shortcut, return: NONE`
                }]
            }]
        });

        const shortcut = result.response.text().trim();
        return shortcut !== 'NONE' ? shortcut : null;
    } catch (e) {
        console.error("Shortcut Advisor Error:", e.message);
        return null;
    }
}

// 5️⃣ VALIDATOR GATEWAY - Enforce rules before execution
async function validatorGateway(action, previousActions, screenshot) {
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const model = ai.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const result = await model.generateContent({
            contents: [{
                parts: [{
                    text: `Current action: ${JSON.stringify(action)}
Previous actions: ${JSON.stringify(previousActions.slice(-3))}

Check: Is this action valid and in correct sequence?
Return: {"valid": true/false, "reason": "..."}
Be strict about sequences (login before search, etc.)`
                }]
            }]
        });

        const validation = extractJSON(result.response.text());
        return validation || { valid: true, reason: "OK" };
    } catch (e) {
        console.error("Validator Error:", e.message);
        return { valid: true, reason: "Validation skipped" };
    }
}

// 6️⃣ TASK DISPATCHER - Route task to best execution method
async function taskDispatcher(userGoal, tools_available) {
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const model = ai.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const result = await model.generateContent({
            contents: [{
                parts: [{
                    text: `Goal: ${userGoal}
Available tools: ${Object.keys(tools_available).join(', ')}

Recommend best approach:
- Use open_app for app opening
- Use mdfind for searching
- Use spotlight_search for complex searches
- Use open_url for URLs
Return: {"recommended_tool": "tool_name", "reason": "..."}
`
                }]
            }]
        });

        const dispatch = extractJSON(result.response.text());
        return dispatch || { recommended_tool: "spotlight_search", reason: "default" };
    } catch (e) {
        console.error("Task Dispatcher Error:", e.message);
        return { recommended_tool: "spotlight_search", reason: "fallback" };
    }
}


// ============================================================================
// 🚀 OPENCLAW PATTERNS INTEGRATION - PRODUCTION-GRADE IMPROVEMENTS
// ============================================================================

// 📊 STEP TRACKING - Full execution history with metadata
class AgentStepTracker {
    constructor() {
        this.steps = [];
        this.startTime = Date.now();
    }

    recordStep(action, args, result, duration, metadata = {}) {
        this.steps.push({
            stepNumber: this.steps.length + 1,
            timestamp: Date.now(),
            action,
            args,
            result,
            duration,
            validated: metadata.validated || false,
            retries: metadata.retries || 0,
            error: metadata.error || null,
            errorChain: metadata.errorChain || []
        });
    }

    getLastStep() {
        return this.steps[this.steps.length - 1] || null;
    }

    summary() {
        const totalDuration = Date.now() - this.startTime;
        return {
            totalSteps: this.steps.length,
            totalDuration,
            failedSteps: this.steps.filter(s => s.error).length,
            validatedSteps: this.steps.filter(s => s.validated).length,
            totalRetries: this.steps.reduce((sum, s) => sum + s.retries, 0),
            avgDurationPerStep: this.steps.length > 0
                ? this.steps.reduce((sum, s) => sum + s.duration, 0) / this.steps.length
                : 0,
            steps: this.steps
        };
    }

    printSummary() {
        const summary = this.summary();
        console.log("\n📊 EXECUTION SUMMARY:");
        console.log(`  Total Steps: \${summary.totalSteps}`);
        console.log(`  Success Rate: \${((summary.totalSteps - summary.failedSteps) / summary.totalSteps * 100).toFixed(1)}%`);
        console.log(`  Validated: \${summary.validatedSteps}/\${summary.totalSteps}`);
        console.log(`  Total Retries: \${summary.totalRetries}`);
        console.log(`  Avg Step Duration: \${summary.avgDurationPerStep.toFixed(0)}ms`);
        console.log(`  Total Duration: \${summary.totalDuration}ms\n`);
    }
}

// 🎯 CATEGORIZED LOGGER - Better log readability
const logger = {
    action: (action, args) => console.log(`🎯 ACTION: \${action}`, JSON.stringify(args).substring(0, 100)),
    validator: (status, reason) => console.log(`🚔 VALIDATOR: \${status} - \${reason}`),
    success: (action, result) => console.log(`✅ SUCCESS: \${action} - \${JSON.stringify(result).substring(0, 80)}`),
    error: (tool, err, context) => {
        console.error(`❌ ERROR in \${tool}:`, err.message);
        if (context) console.error('   Context:', context);
    },
    retry: (attempt, maxAttempts, delay) => console.log(`🔄 RETRY: Attempt \${attempt}/\${maxAttempts} in \${delay}ms`),
    debug: process.env.DEBUG ? console.debug : () => { },
    info: (msg) => console.log(`ℹ️  \${msg}`),
    step: (num, action) => console.log(`
━━━ Step \${num}: \${action} ━━━`)
};
// 🚔 SPOTLIGHT VALIDATOR STATE


// 🔗 ERROR CONTEXT - Detailed error chains
class DetailedError extends Error {
    constructor(message, context = {}) {
        super(message);
        this.name = this.constructor.name;
        this.context = {
            tool: context.tool || 'unknown',
            action: context.action || 'unknown',
            args: context.args || null,
            attempt: context.attempt || 1,
            previousErrors: context.previousErrors || [],
            timestamp: Date.now(),
            ...context
        };
    }

    toString() {
        return `
        Error: \${this.message}
        Tool: \${this.context.tool}
        Action: \${this.context.action}
        Args: \${JSON.stringify(this.context.args)}
        Attempt: \${this.context.attempt}
        Previous Errors: \${this.context.previousErrors.map(e => e.message).join(' → ')}
        `;
    }
}

// ⚙️ ADVANCED RETRY WITH JITTER (from OpenClaw)
async function retryWithAdvancedBackoff(fn, options = {}) {
    const {
        attempts = 3,
        minDelayMs = 300,
        maxDelayMs = 30000,
        jitter = 0.1,
        label = 'Operation',
        shouldRetry = (err) => true,
        onRetry = null
    } = options;

    let lastError;
    const errorChain = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            errorChain.push(err);

            if (!shouldRetry(err, attempt) || attempt === attempts) {
                throw new DetailedError(err.message, {
                    action: label,
                    attempt,
                    previousErrors: errorChain.slice(0, -1),
                    originalError: err
                });
            }

            // Calculate exponential backoff with jitter
            let delay = minDelayMs * Math.pow(2, attempt - 1);
            delay = Math.min(delay, maxDelayMs);

            // Apply jitter: delay * (1 + random between -jitter and +jitter)
            const jitterAmount = delay * ((Math.random() * 2 - 1) * jitter);
            delay = Math.max(0, Math.round(delay + jitterAmount));

            logger.retry(attempt, attempts, delay);

            if (onRetry) {
                onRetry({
                    attempt,
                    maxAttempts: attempts,
                    delayMs: delay,
                    error: err,
                    label
                });
            }

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

// ✅ VALIDATION FRAMEWORK (from OpenClaw)
class ValidationResult {
    constructor(valid = true, errors = [], warnings = []) {
        this.valid = valid;
        this.errors = errors;
        this.warnings = warnings;
        this.timestamp = Date.now();
    }

    addError(field, message) {
        this.errors.push({ field, message });
        this.valid = false;
    }

    addWarning(message) {
        this.warnings.push(message);
    }

    report() {
        if (this.valid && this.warnings.length === 0) {
            return { valid: true };
        }

        const report = {
            valid: this.valid,
            errors: this.errors,
            warnings: this.warnings
        };

        if (this.errors.length > 0) {
            console.error('❌ VALIDATION ERRORS:');
            this.errors.forEach(e => console.error(`   - \${e.field}: \${e.message}`));
        }

        if (this.warnings.length > 0) {
            console.warn('⚠️  VALIDATION WARNINGS:');
            this.warnings.forEach(w => console.warn(`   - \${w}`));
        }

        return report;
    }
}

// 🔍 ACTION VALIDATOR (General Purpose)
function validateActionInput(action) {
    const validation = new ValidationResult();
    // Validation framework in place for future extensions
    return validation;
}

// 🔎 Heuristics: Detect file/folder operations and infer shell commands
function isFileOperationGoal(goal = "") {
    const g = goal.toLowerCase();
    return (
        g.includes("create folder") ||
        g.includes("make folder") ||
        g.includes("new folder") ||
        g.includes("create directory") ||
        g.includes("make directory") ||
        g.includes("mkdir") ||
        g.includes("list files") ||
        g.includes("show files") ||
        g.startsWith("ls") ||
        g.includes("find file") ||
        g.includes("search file") ||
        g.includes("locate file")
    );
}

function inferShellCommand(goal = "") {
    const g = goal.toLowerCase();

    // List files
    if (g.includes("list files") || g.includes("show files") || g.startsWith("ls")) {
        if (g.includes("desktop")) return "ls ~/Desktop";
        if (g.includes("documents")) return "ls ~/Documents";
        if (g.includes("downloads")) return "ls ~/Downloads";
        return "ls";
    }

    // Create folder
    if (
        g.includes("create folder") ||
        g.includes("make folder") ||
        g.includes("new folder") ||
        g.includes("create directory") ||
        g.includes("make directory") ||
        g.includes("mkdir")
    ) {
        let folderName = null;

        // Quoted name
        const quoteMatch = goal.match(/["']([^"']+)["']/);
        if (quoteMatch) folderName = quoteMatch[1];

        // Named/called pattern
        if (!folderName) {
            const namedMatch = goal.match(/(?:named|called)\\s+([\\w\\-\\s]+)/i);
            if (namedMatch) folderName = namedMatch[1].trim();
        }

        if (!folderName) folderName = "new_folder";

        let base = "";
        if (g.includes("desktop")) base = "~/Desktop/";
        else if (g.includes("documents")) base = "~/Documents/";
        else if (g.includes("downloads")) base = "~/Downloads/";

        const safeName = folderName.replace(/[\\/]/g, "_").trim();
        return `mkdir -p ${base}${safeName}`;
    }

    return null;
}

function shouldResolveMediaUrl(goal = "") {
    const g = goal.toLowerCase();
    const platform = inferMediaPlatform(goal);
    // If the user provided a direct platform URL, always treat it as resolvable (and lock onto it).
    if (extractDirectMediaUrlFromGoal(goal, platform)) return true;
    // Comment can exist on both platforms; treat it as selector-worthy too.
    const hasSelector =
        g.includes("most viewed") ||
        g.includes("first vlog") ||
        g.includes("first video") ||
        g.includes("earliest video") ||
        g.includes("latest post") ||
        g.includes("latest video") ||
        g.includes("latest") ||
        g.includes("from channel") ||
        g.includes("video") ||
        g.includes("post") ||
        g.includes("reel") ||
        /(comment|commont|coment|commet|commment)\b/i.test(g);
    return Boolean(platform) && hasSelector;
}

function inferMediaPlatform(goal = "") {
    const g = goal.toLowerCase();

    if (g.includes("instagram") || g.includes("insta")) return "instagram";
    if (g.includes("youtube") || g.includes("yt ")) return "youtube";

    const instagramSignals = [
        "latest post",
        "newest post",
        "reel",
        "profile",
        "story",
        "followers",
        "following",
        "dm"
    ];

    const youtubeSignals = [
        "video",
        "channel",
        "vlog",
        "most viewed",
        "likes and dislikes",
        "subscribe",
        "watch",
        "playlist",
        "shorts"
    ];

    const score = (signals) => signals.reduce((acc, s) => acc + (g.includes(s) ? 1 : 0), 0);
    const igScore = score(instagramSignals);
    const ytScore = score(youtubeSignals);

    if (ytScore > igScore) return "youtube";
    if (igScore > ytScore) return "instagram";

    // Tie-breakers: treat "post/reel" as Instagram and "video/channel/vlog" as YouTube.
    if (/\b(post|reel|story)\b/i.test(g)) return "instagram";
    if (/\b(video|channel|vlog|playlist|watch)\b/i.test(g)) return "youtube";

    return "youtube"; // safer default for ambiguous "comment on X's video" style requests
}

function extractLatestUserInputLine(goal = "") {
    const g = String(goal || "");
    const matches = [...g.matchAll(/\buser input:\s*([^\n]+)/gi)];
    if (!matches.length) return "";
    return String(matches[matches.length - 1][1] || "").trim();
}

function isWeakYouTubeFollowupInput(text = "") {
    const t = normForMatch(String(text || ""));
    if (!t) return true;
    if (/^(latest|first|earliest|oldest|same|again|retry|reupload|search reupload|use current)$/i.test(t)) return true;
    const words = t.split(" ").filter(Boolean);
    if (words.length <= 2 && !/\b(video|vlog|youtube|channel|watch|linux|instagram|reddit|twitter)\b/i.test(t)) return true;
    return false;
}

function isYouTubeIntentText(text = "") {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return (
        t.includes("youtube") ||
        t.includes("yt ") ||
        t.includes("video") ||
        t.includes("vlog") ||
        t.includes("channel") ||
        t.includes("latest") ||
        t.includes("first") ||
        t.includes("oldest") ||
        t.includes("earliest") ||
        t.includes("most viewed")
    );
}

function stripCommentInstructionsForLookup(text = "") {
    let s = String(text || "");
    // Remove injected control blocks if present.
    s = s.replace(/SUGGESTED_COMMENT:[\s\S]*/ig, " ");
    s = s.replace(/SUGGESTED_QUOTE:[\s\S]*/ig, " ");
    s = s.replace(/TOPIC_HINT:[\s\S]*/ig, " ");
    s = s.replace(/\buser input:\s*/ig, " ");
    const withoutControlBlocks = s;

    // Remove trailing comment/quote instructions, but do not over-trim the lookup phrase.
    s = s.replace(/\b(and then|then|also|after that)\b[\s\S]*?\b(comment|commont|coment|commet|quote|reply|post)\b[\s\S]*$/i, " ");
    const cleaned = s.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
    // Guard against over-trimming (e.g., goals that start with "comment on ...").
    // Fall back to the control-block-stripped version instead of raw original text.
    return String(withoutControlBlocks).replace(/\s+/g, " ").trim();
}

function getYouTubeLookupGoal(goal = "") {
    const g = String(goal || "");
    const latestInput = extractLatestUserInputLine(g);
    const latestClean = stripCommentInstructionsForLookup(latestInput);
    const canUseLatest =
        isYouTubeIntentText(latestInput) &&
        !isWeakYouTubeFollowupInput(latestClean);
    const source = canUseLatest ? latestClean : g;
    const cleaned = stripCommentInstructionsForLookup(source);
    return cleaned || stripCommentInstructionsForLookup(g) || (latestInput || g).trim();
}

function isValidPlatformUrl(platform, url) {
    if (!url || typeof url !== "string") return false;
    const u = url.toLowerCase();
    if (platform === "youtube") return u.includes("youtube.com/") || u.includes("youtu.be/");
    if (platform === "instagram") return u.includes("instagram.com/");
    return false;
}

function extractDirectMediaUrlFromGoal(goal = "", platform = "") {
    const text = String(goal || "");
    const tokens = text.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
        if (!/^https?:\/\//i.test(tok)) continue;
        const url = tok.replace(/[\]")'.,!?]+$/, "");
        if (isValidPlatformUrl(platform, url)) return url;
    }
    return null;
}

async function resolveMediaTarget(goal) {
    const platform = inferMediaPlatform(goal) || "youtube";
    const prompt = platform === "youtube"
        ? `Return ONLY JSON.
Goal: pick playable, correct YouTube watch URLs for this user request.

Format:
{"platform":"youtube","candidates":[{"title":"...","url":"...","channel":"...","availability":"public|private|unavailable|unknown","reuploaded":true|false,"why":"..."}]}

	Rules:
	- Return 3 candidates (or fewer if truly impossible).
	- Each "url" must be a DIRECT watch/share URL:
	  - https://www.youtube.com/watch?v=VIDEO_ID  OR  https://youtu.be/VIDEO_ID
	  - Do NOT return: channel URLs, playlist URLs, search URLs, @handles, /results, /feed, /videos.
- Candidates must be PUBLIC and PLAYABLE right now (not private/unavailable/removed).
- If the request mentions a channel/person (ex: "PewDiePie"), candidates must be from that channel.
- If request includes a topic keyword (ex: "linux"), it must appear in the video title or description.
- If request says "latest", prefer the most recent upload that matches.
- If request says "first/earliest/oldest", prefer the earliest public upload that matches.
- If original target is private/unavailable, include best reuploaded alternatives with reuploaded=true.
- No markdown. No prose. JSON only.

User request: ${goal}`
        : `Return ONLY JSON with one best Instagram destination for the request.
Format: {"platform":"instagram","title":"...","url":"...","profile_url":"...","confidence":"high|medium|low"}
Rules:
- if post-level URL is uncertain, set "url" to profile_url
- prefer stable profile URL when uncertain
- no markdown, no prose
User request: ${goal}`;
    try {
        const response = await getAi().models.generateContent({
            model: VALIDATOR_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const data = extractJSON(text) || JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
        if (platform === "youtube") {
            const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
            const first = candidates.find((c) => isValidPlatformUrl("youtube", String(c?.url || ""))) || null;
            const chosenUrl = first ? String(first.url || "") : String(data?.url || "");
            if (!isValidPlatformUrl("youtube", chosenUrl)) return null;
            return {
                platform,
                title: String(first?.title || data?.title || ""),
                url: chosenUrl,
                candidates
            };
        }

        const chosenUrl = data.url || data.profile_url || data.fallback_profile_url;
        if (!isValidPlatformUrl(platform, chosenUrl)) return null;
        return { platform, title: data.title || "", url: chosenUrl };
    } catch (e) {
        if (isGeminiRateLimitError(e)) {
            const delay = parseRetryDelayMsFromError(e) || 35000;
            setGeminiCooldown(delay);
            return { rate_limited: true, retry_after_ms: delay };
        }
        console.error("Media resolver error:", e.message);
        return null;
    }
}

function extractYouTubeChannelHint(goal = "") {
    const g = String(goal || "");
    const cleanup = (s = "") =>
        String(s || "")
            .replace(/\b(the|a|an)\b\s*/i, "")
            .replace(/["']/g, "")
            .replace(/\s+/g, " ")
            .trim();
    const m1 = g.match(/\bfrom\s+channel\s+([^\n]+?)(?:\s|$)/i);
    if (m1) return cleanup(String(m1[1] || ""));
    const m2 = g.match(/\b([A-Za-z0-9._-]{2,})'s\s+(?:latest|first|most viewed|newest|earliest)\s+(?:video|vlog)\b/i);
    if (m2) return cleanup(String(m2[1] || ""));
    const m3 = g.match(/\b(comment on|open)\s+([A-Za-z0-9._-]{2,})\s+(?:latest|first|most viewed|newest|earliest)\s+(?:video|vlog)\b/i);
    if (m3) return cleanup(String(m3[2] || ""));
    const m4 = g.match(/\b(?:for|from)\s+(?:the\s+)?([A-Za-z0-9._ -]{2,40}?)\s+(?:latest|first|most viewed|newest|earliest)\b/i);
    if (m4) return cleanup(String(m4[1] || ""));
    const m5 = g.match(/\b(?:by)\s+([A-Za-z0-9._ -]{2,40}?)\s+(?:latest|first|most viewed|newest|earliest)\b/i);
    if (m5) return cleanup(String(m5[1] || ""));
    // "the PewDiePie latest linux video"
    const m6 = g.match(/\b(?:the\s+)?([A-Za-z0-9._ -]{2,40}?)\s+(?:latest|first|most viewed|newest|earliest)\s+[A-Za-z0-9._ -]*\b(?:video|vlog)\b/i);
    if (m6) return cleanup(String(m6[1] || ""));
    // "latest linux video by PewDiePie"
    const m7 = g.match(/\b(?:latest|first|most viewed|newest|earliest)\s+[A-Za-z0-9._ -]*\b(?:video|vlog)\b\s+by\s+([A-Za-z0-9._ -]{2,40})\b/i);
    if (m7) return cleanup(String(m7[1] || ""));
    return "";
}

function wantsEarliest(goal = "") {
    return /\b(first|earliest|oldest)\b/i.test(String(goal || "")) && /\b(video|vlog)\b/i.test(String(goal || ""));
}

function wantsMostViewed(goal = "") {
    return /\b(most viewed|most popular|popular)\b/i.test(String(goal || "")) && /\b(video|vlog)\b/i.test(String(goal || ""));
}

function isHardUnavailableStatus(status) {
    const s = status || null;
    if (!s || s.ok !== true || s.available !== false) return false;
    const reason = String(s.reason || "").toLowerCase();
    if (!reason) return true;
    if (reason.includes("not_watch_page")) return false;
    if (reason.includes("not watch page")) return false;
    return true;
}

function safeJsonParse(text = "") {
    const t = String(text || "").trim();
    if (!t) return null;
    try {
        return JSON.parse(t);
    } catch {}
    try {
        const cleaned = t.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(cleaned);
    } catch {}
    return null;
}

async function resolveYouTubeChannelUrl(channelHint = "") {
    const hint = String(channelHint || "").trim();
    if (!hint) return "";
    if (hint.startsWith("@")) return `https://www.youtube.com/${hint}`;
    if (/^https?:\/\//i.test(hint) && hint.includes("youtube.com/")) return hint;

    // Only resolve the channel URL/handle, not a specific video URL.
    const prompt = `Return ONLY JSON: {"channel_url":"https://www.youtube.com/@HANDLE"} or {"channel_url":"https://www.youtube.com/channel/CHANNEL_ID"}.
Rules:
- channel_url must be a real YouTube channel URL (no /results, no /watch, no playlists).
- Use the most stable official URL you can.
Channel name hint: ${hint}`;

    try {
        const response = await getAi().models.generateContent({
            model: VALIDATOR_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const data = extractJSON(text) || safeJsonParse(text) || null;
        const url = String(data?.channel_url || "").trim();
        if (!url) return "";
        if (!/youtube\.com\/(@|channel\/)/i.test(url)) return "";
        return url;
    } catch (e) {
        if (isGeminiRateLimitError(e)) {
            const delay = parseRetryDelayMsFromError(e) || 20000;
            setGeminiCooldown(delay);
        }
        return "";
    }
}

function buildYouTubeChannelVideosUrl(channelUrl = "", sort = "dd") {
    const base = String(channelUrl || "").replace(/\/+$/, "");
    if (!base) return "";
    const s = ["dd", "da", "p"].includes(sort) ? sort : "dd";
    return `${base}/videos?view=0&sort=${s}&shelf_id=0`;
}

function parsePublishedAgeToDays(text = "") {
    const s = String(text || "").toLowerCase().trim();
    if (!s) return null;
    if (s.includes("just now")) return 0;
    if (s.includes("yesterday")) return 1;
    const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = String(m[2] || "").toLowerCase();
    if (!Number.isFinite(n)) return null;
    if (unit.startsWith("second")) return n / 86400;
    if (unit.startsWith("minute")) return n / 1440;
    if (unit.startsWith("hour")) return n / 24;
    if (unit.startsWith("day")) return n;
    if (unit.startsWith("week")) return n * 7;
    if (unit.startsWith("month")) return n * 30;
    if (unit.startsWith("year")) return n * 365;
    return null;
}

function parseViewsToNumber(text = "") {
    const s = String(text || "").toLowerCase().replace(/,/g, "").trim();
    if (!s) return null;
    if (s.includes("no views")) return 0;
    const m = s.match(/(\d+(?:\.\d+)?)\s*([kmb])?\s*views?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const suf = String(m[2] || "").toLowerCase();
    if (suf === "k") n *= 1_000;
    else if (suf === "m") n *= 1_000_000;
    else if (suf === "b") n *= 1_000_000_000;
    return Math.round(n);
}

function earliestTitleHintOk(title = "") {
    const t = String(title || "").toLowerCase();
    if (!t) return false;
    return /\b(first|1st|ep\.?\s*1|episode\s*1|part\s*1)\b/i.test(t);
}

async function youtubeListChannelVideos(channelUrl = "", sort = "dd") {
    if (global.chromeJsDisabled) return null;
    if (!tools.chrome_eval || !tools.chrome_wait) return null;

    const url = buildYouTubeChannelVideosUrl(channelUrl, sort);
    if (!url) return null;

    await openUrlInChromeSameTab(url);
    await applyChromeTabHygiene();

    try {
        await tools.chrome_wait({
            predicate_js:
                "document.readyState !== 'loading' && " +
                "(document.querySelectorAll('a#video-title-link, a#video-title').length > 0 || " +
                "document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer').length > 0)",
            timeout_ms: 9000,
            interval_ms: 180
        });
    } catch {}

    const script = `(function(){try{
  const norm=(s)=>String(s||"").replace(/\\s+/g," ").trim();
  const out=[];
  const pickHref=(a)=>{
    if(!a) return "";
    const h=a.href || (a.getAttribute && a.getAttribute("href")) || "";
    if(!h) return "";
    if(String(h).startsWith("/")) return "https://www.youtube.com"+h;
    return String(h);
  };
  const nodes=[...document.querySelectorAll("ytd-rich-item-renderer,ytd-grid-video-renderer")].slice(0,80);
  for(const n of nodes){
    const a=n.querySelector("a#video-title-link,a#video-title");
    const href=pickHref(a);
    if(!href) continue;
    if(!/\\/watch\\?v=|\\/shorts\\//.test(href)) continue;
    const title=norm(a && a.textContent);
    if(!title) continue;
    if(out.find(x=>x.url===href)) continue;
    const spans=[...n.querySelectorAll("#metadata-line span, #metadata span, #details #metadata-line span")].map(x=>norm(x&&x.textContent)).filter(Boolean);
    const published=spans.find(x=>/ago|streamed|premiered|yesterday|today|hour|day|week|month|year/i.test(String(x||"")))||"";
    const views=spans.find(x=>/view/i.test(String(x||"")))||"";
    out.push({title,url:href,published,views});
    if(out.length>=20) break;
  }
  if(!out.length){
    const links=[...document.querySelectorAll("a[href*='watch?v='],a[href*='/shorts/']")].slice(0,120);
    for(const a of links){
      const href=pickHref(a);
      const title=norm(a.textContent);
      if(!href || !title) continue;
      if(out.find(x=>x.url===href)) continue;
      out.push({title,url:href,published:"",views:""});
      if(out.length>=20) break;
    }
  }
  return JSON.stringify({ok:true,url:location.href,results:out});
}catch(err){return JSON.stringify({ok:false,error:String((err&&err.message)||err)});}})();`;

    const raw = await tools.chrome_eval({ script });
    const parsed = extractJSON(String(raw)) || null;
    if (!parsed || parsed.ok !== true) return null;
    return parsed;
}

async function resolveYouTubeViaChannelDom(goal, runState) {
    if (global.chromeJsDisabled) return null;
    if (!tools.youtube_get_status || !tools.youtube_get_video_meta) return null;

    const channelHint = extractYouTubeChannelHint(goal).trim();
    if (!channelHint) return null;

    const channelUrl = await resolveYouTubeChannelUrl(channelHint);
    if (!channelUrl) return null;

    const earliestRequested = wantsEarliest(goal);
    const mostViewedRequested = wantsMostViewed(goal);
    const sort = earliestRequested ? "da" : (mostViewedRequested ? "p" : "dd");
    const listing = await youtubeListChannelVideos(channelUrl, sort);
    const results = Array.isArray(listing?.results) ? listing.results : [];
    if (!results.length) return null;

    const keywords = extractTopicKeywords(goal, channelHint);
    const requireVlog = wantsVlog(goal);
    const lowerKw = keywords.map(k => String(k || "").toLowerCase()).filter(Boolean);

    let ordered = [...results];
    if (earliestRequested) {
        const known = ordered
            .map((r) => ({ r, days: parsePublishedAgeToDays(r?.published) }))
            .filter((x) => x.days != null);
        if (known.length >= 3) {
            known.sort((a, b) => b.days - a.days); // oldest first (largest days ago)
            ordered = known.map((x) => x.r);
        } else {
            return {
                ok: false,
                needs_search: true,
                reason: "missing_publish_age",
                channel_url: channelUrl
            };
        }
    } else if (mostViewedRequested) {
        const known = ordered
            .map((r) => ({ r, views: parseViewsToNumber(r?.views) }))
            .filter((x) => x.views != null);
        if (known.length >= 3) {
            known.sort((a, b) => b.views - a.views);
            ordered = known.map((x) => x.r);
        }
    }

    const pickMatch = () => {
        for (const r of ordered) {
            const title = String(r?.title || "");
            const t = title.toLowerCase();
            if (requireVlog && !t.includes("vlog")) continue;
            if (lowerKw.length) {
                const ok = lowerKw.every((k) => t.includes(k) || fuzzyKeywordMatch(t, k));
                if (!ok) continue;
            }
            if (earliestRequested && requireVlog && !earliestTitleHintOk(t)) continue;
            return r;
        }
        return null;
    };

    const picked = pickMatch();
    if (!picked) {
        return {
            ok: false,
            needs_search: true,
            reason: earliestRequested ? "no_earliest_match_in_channel_listing" : "no_match_in_channel_listing",
            channel_url: channelUrl
        };
    }
    if (lowerKw.length) {
        const pickedTitle = String(picked?.title || "").toLowerCase();
        const matched = lowerKw.every((k) => pickedTitle.includes(k) || fuzzyKeywordMatch(pickedTitle, k));
        if (!matched) {
            return {
                ok: false,
                needs_search: true,
                reason: "no_recent_keyword_match",
                channel_url: channelUrl
            };
        }
    }
    const url = String(picked?.url || "").trim();
    if (!isValidPlatformUrl("youtube", url)) return null;

    // Validate availability quickly to avoid false success on private videos.
    await openUrlInChromeSameTab(url);
    await applyChromeTabHygiene();
    await new Promise(r => setTimeout(r, 900));

    const statusRaw = await tools.youtube_get_status({});
    const status = extractJSON(String(statusRaw)) || null;
    if (isHardUnavailableStatus(status)) {
        return {
            ok: false,
            unavailable: true,
            reason: status.reason || "unavailable",
            channel_url: channelUrl,
            attempted_url: url
        };
    }

    const meta = await getYouTubeMetaWithRetry(4);
    const title = String(meta?.title || status?.title || picked?.title || "").trim();

    runState.cache = runState.cache || Object.create(null);
    runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || url;
    runState.cache.youtube_last_playable = { url, title, channel: channelHint };

    return { ok: true, url, title, channel: channelHint, source: "channel_dom" };
}

async function applyChromeTabHygiene() {
    try {
        if (global.chromeJsDisabled) return;
        if (tools.chrome_tab_hygiene) {
            await tools.chrome_tab_hygiene({ keep: 2 });
        }
    } catch {}
}

async function openUrlInChromeSameTab(url) {
    const u = String(url || "").trim();
    if (!u) return "error: url required";
    // Keep this deterministic and fast: direct open in Chrome.
    return await tools.shell({ command: `open -a "Google Chrome" "${u}"` });
}

function wantsVlog(goal = "") {
    return /\bvlog\b/i.test(String(goal || ""));
}

function extractFirstHttpUrl(text = "") {
    const t = String(text || "");
    const m = t.match(/https?:\/\/[^\s"'<>]+/i);
    if (!m) return "";
    return String(m[0]).replace(/[\]")'.,!?]+$/, "");
}

function isYouTubeWatchUrl(u = "") {
    const s = String(u || "").toLowerCase();
    return (
        s.includes("youtube.com/watch") ||
        s.includes("youtube.com/shorts/") ||
        s.includes("youtu.be/")
    );
}

function extractYouTubeVideoId(u = "") {
    try {
        const url = new URL(String(u || ""));
        const host = String(url.hostname || "").toLowerCase();
        const path = String(url.pathname || "");
        if (host.includes("youtu.be")) {
            const id = path.split("/").filter(Boolean)[0] || "";
            return id ? id.split(/[?#&/]/)[0] : "";
        }
        if (path.startsWith("/shorts/")) {
            return path.split("/shorts/")[1]?.split(/[?#&/]/)[0] || "";
        }
        const v = url.searchParams.get("v");
        return v || "";
    } catch {
        return "";
    }
}

function isSameYouTubeVideoUrl(a = "", b = "") {
    const aId = extractYouTubeVideoId(a);
    const bId = extractYouTubeVideoId(b);
    if (aId && bId) return aId === bId;
    return String(a || "").trim() === String(b || "").trim();
}

function normalizeGoalFromUserInput(goal = "") {
    const g = String(goal || "");
    const m = g.match(/\buser input:\s*([^\n]+)\b/i);
    if (!m) return g;
    const ui = String(m[1] || "").trim().toLowerCase();
    if (ui.includes("latest")) {
        // If the user explicitly switches to "latest", drop "first/earliest/oldest" constraints.
        return g
            .replace(/\b(first vlog|first video|earliest video|oldest video|earliest|oldest)\b/gi, "latest video")
            .replace(/\bfirst\b/gi, "latest");
    }
    return g;
}

function extractTopicKeywords(goal = "", channelHint = "") {
    const g = String(goal || "").toLowerCase();
    const ch = String(channelHint || "").toLowerCase();
    const chTokens = new Set(ch.split(/[^a-z0-9]+/g).map(s => s.trim()).filter(Boolean));
    const stop = new Set([
        "open","comment","on","the","a","an","latest","first","most","viewed","video","vlog","newest","earliest",
        "from","channel","please","then","and","of","in","to","for","with","about"
    ]);
    const keep = [];
    // Simple keyword harvest: words length>=4 not in stop set.
    for (const raw of g.split(/[^a-z0-9]+/g)) {
        const w = raw.trim();
        if (!w) continue;
        if (w.length < 4) continue;
        if (stop.has(w)) continue;
        if (chTokens.has(w)) continue; // channel name is checked separately
        keep.push(w);
    }
    // De-dupe and cap.
    return Array.from(new Set(keep)).slice(0, 4);
}

function normForMatch(s = "") {
    return String(s || "")
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizeForMatch(s = "") {
    const txt = normForMatch(s);
    if (!txt) return [];
    const stop = new Set([
        "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "from",
        "video", "vlog", "official", "new", "latest", "full", "episode", "ep", "clip", "shorts"
    ]);
    return txt
        .split(" ")
        .map((t) => t.trim())
        .filter((t) => t && t.length >= 3 && !stop.has(t));
}

function jaccardSimilarity(aTokens = [], bTokens = []) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
}

function titleMatchOk(expectedTitle = "", actualTitle = "") {
    const e = String(expectedTitle || "").trim();
    const a = String(actualTitle || "").trim();
    if (!e || !a) return false;
    const eNorm = normForMatch(e);
    const aNorm = normForMatch(a);
    if (!eNorm || !aNorm) return false;

    // Fast containment for long/precise titles.
    if (eNorm.length >= 14 && (aNorm.includes(eNorm) || eNorm.includes(aNorm))) return true;

    const score = jaccardSimilarity(tokenizeForMatch(eNorm), tokenizeForMatch(aNorm));
    return score >= 0.45;
}

async function getYouTubeMetaWithRetry(maxAttempts = 3) {
    if (!tools.youtube_get_video_meta) return null;
    const tries = Math.max(1, Math.min(5, parseInt(maxAttempts, 10) || 3));
    for (let i = 0; i < tries; i++) {
        const metaRaw = await tools.youtube_get_video_meta({});
        const meta = extractJSON(String(metaRaw)) || null;
        if (meta && meta.ok === true && meta.is_watch === true && String(meta.title || "").trim()) return meta;
        await new Promise((r) => setTimeout(r, 450));
    }
    // Return the last meta even if incomplete (caller can decide).
    try {
        const metaRaw = await tools.youtube_get_video_meta({});
        return extractJSON(String(metaRaw)) || null;
    } catch {
        return null;
    }
}

function levenshteinDistance(a = "", b = "") {
    const s = String(a || "");
    const t = String(b || "");
    const n = s.length;
    const m = t.length;
    if (!n) return m;
    if (!m) return n;
    // Small-string DP; our tokens are short so this is fine.
    const prev = new Array(m + 1);
    const cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
        cur[0] = i;
        const sc = s.charCodeAt(i - 1);
        for (let j = 1; j <= m; j++) {
            const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + cost
            );
        }
        for (let j = 0; j <= m; j++) prev[j] = cur[j];
    }
    return prev[m];
}

function fuzzyKeywordMatch(haystack = "", keyword = "") {
    const kw = normForMatch(keyword);
    if (!kw) return false;
    const h = normForMatch(haystack);
    if (!h) return false;
    if (h.includes(kw)) return true;

    const words = h.split(" ").filter(Boolean);
    const limit = kw.length >= 5 ? 2 : 1; // allow 2 edits for mid/long words (handles typos like "lenox" vs "linux")
    for (const w of words) {
        if (!w) continue;
        if (Math.abs(w.length - kw.length) > limit) continue;
        const d = levenshteinDistance(w, kw);
        if (d <= limit) return true;
    }
    return false;
}

async function pickWorkingYouTubeUrl(goal, candidates, runState) {
    const channelHint = extractYouTubeChannelHint(goal).toLowerCase();
    const keywords = extractTopicKeywords(goal, channelHint);
    const requireVlog = wantsVlog(goal);
    const earliestRequested = wantsEarliest(goal);
    const allowOtherChannels = /\buser input:\s*search reupload\b/i.test(String(goal || "")) || /\breupload\b/i.test(String(goal || ""));
    const useCurrent = /\buser input:\s*use current\b/i.test(String(goal || "")) || /\buse current\b/i.test(String(goal || ""));
    // Keep this small to avoid opening many different videos and confusing the user.
    const max = Math.min(3, Array.isArray(candidates) ? candidates.length : 0);

    runState.cache = runState.cache || Object.create(null);
    runState.cache.youtube_candidates_tried = runState.cache.youtube_candidates_tried || [];
    runState.cache.youtube_last_playable = runState.cache.youtube_last_playable || null;

    if (useCurrent && runState.cache.youtube_last_playable?.url) {
        const cur = runState.cache.youtube_last_playable;
        return { ok: true, url: String(cur.url), title: String(cur.title || ""), channel: String(cur.channel || "") };
    }

    let lastPlayable = null;
    let unavailableCandidateCount = 0;
    const unavailableReasons = new Set();

    for (let i = 0; i < max; i++) {
        const c = candidates[i];
        const url = String(c?.url || "").trim();
        if (!isValidPlatformUrl("youtube", url)) continue;
        if (runState.cache.youtube_candidates_tried.includes(url)) continue;
        runState.cache.youtube_candidates_tried.push(url);

        await openUrlInChromeSameTab(url);
        await applyChromeTabHygiene();
        await new Promise(r => setTimeout(r, 320));
        try {
	            if (tools.chrome_wait) {
	                await tools.chrome_wait({
	                    predicate_js:
	                        "!!location.hostname && location.hostname.includes('youtube') && " +
	                        "((location.pathname==='/watch') || location.pathname.startsWith('/shorts/')) && " +
	                        "(function(){const h=document.querySelector(\"h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h1 yt-formatted-string\");" +
	                        "const ht=h?String(h.textContent||'').trim():'';" +
	                        "const dt=String(document.title||'').trim();" +
	                        "return ht.length>0 && dt.length>0;})()",
	                    timeout_ms: 9000,
	                    interval_ms: 180
	                });
	            }
	        } catch {}

        let status = null;
        if (tools.youtube_get_status) {
            const statusRaw = await tools.youtube_get_status({});
            status = extractJSON(String(statusRaw)) || null;
            if (isHardUnavailableStatus(status)) {
                unavailableCandidateCount++;
                const reason = String(status?.reason || "").trim();
                if (reason) unavailableReasons.add(reason);
                continue;
            }
        }

        const meta = await getYouTubeMetaWithRetry(4);
        if (meta && meta.ok === true && meta.is_watch === true) {
            const titleText = String(meta.title || status?.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
            const title = titleText.toLowerCase();
            const desc = String(meta.description || "").toLowerCase();
            const channel = String(meta.channel || "").toLowerCase();

            // Track the last playable watch page we opened so the user can say "use current".
            lastPlayable = { url, title: meta.title || c?.title || "", channel: meta.channel || c?.channel || "" };
            runState.cache.youtube_last_playable = lastPlayable;

            const channelOk =
                allowOtherChannels ||
                !channelHint ||
                !channel ||
                normForMatch(channel).includes(normForMatch(channelHint));
            if (!channelOk) continue;

            const vlogOk = !requireVlog || title.includes("vlog") || desc.includes("vlog") || String(c?.title || "").toLowerCase().includes("vlog");
            if (!vlogOk) continue;

            const kwOk = keywords.length === 0
                ? true
                : keywords.every((kw) => {
                      const k = String(kw || "").toLowerCase();
                      if (!k) return true;
                      return title.includes(k) || desc.includes(k) || fuzzyKeywordMatch(title, k) || fuzzyKeywordMatch(desc, k);
                  });

            const expectedTitle = String(c?.title || "").trim();
            const titleOk = expectedTitle ? titleMatchOk(expectedTitle, titleText) : false;
            const earliestOk = !earliestRequested || earliestTitleHintOk(titleText || expectedTitle);

            // Accept if either:
            // - The opened title matches the candidate title (most reliable when Gemini URL is wrong but title is right), OR
            // - The goal keywords match title/description.
            if ((!titleOk && !kwOk) || (earliestRequested && !earliestOk && keywords.length === 0)) {
                // If we already opened a playable watch page from the intended channel, stop here and ask the user
                // instead of opening more random candidates (prevents "found it then switched and claimed failure").
                if (status && status.ok === true && status.available === true && channelOk) {
                    const playableLine = `I opened a playable YouTube watch page but it doesn't clearly match your request:\n- ${String(titleText || meta.title || status?.title || "").slice(0, 140)}\n- ${url}\nReply with:\n0) use current\n1) search reupload\n2) latest\n3) a specific YouTube URL\n4) a more exact video title`;
                    return { ok: false, question: playableLine };
                }
                continue;
            }

            // If status exists and says playable, we are done.
            if (status && status.ok === true && status.available === true) {
                runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || url;
                return { ok: true, url, title: titleText || meta.title || c?.title || "", channel: meta.channel || c?.channel || "" };
            }

            // If status isn't available, still accept based on DOM meta.
            runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || url;
            return { ok: true, url, title: titleText || meta.title || c?.title || "", channel: meta.channel || c?.channel || "" };
        }

        // If meta tool isn't returning yet but status says playable, accept using Chrome context title.
        if (status && status.ok === true && status.available === true && tools.chrome_get_context && !global.chromeJsDisabled) {
            const ctxRaw = await tools.chrome_get_context({});
            const ctx = extractJSON(String(ctxRaw)) || null;
            const ctxTitle = String(ctx?.title || "");
            lastPlayable = { url, title: ctxTitle || String(c?.title || ""), channel: String(c?.channel || "") };
            runState.cache.youtube_last_playable = lastPlayable;
            if (!String(c?.title || "").trim() || titleMatchOk(String(c?.title || ""), ctxTitle)) {
                runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || url;
                return { ok: true, url, title: ctxTitle || String(c?.title || ""), channel: String(c?.channel || "") };
            }
        }
    }

    // Fallback: if Gemini candidates are bad/wrong, do a deterministic YouTube search and validate via DOM/meta.
    if (tools.youtube_search && !global.chromeJsDisabled) {
        const requireVlog2 = wantsVlog(goal);
        const trySearch = async (query) => {
            const searchRaw = await tools.youtube_search({ query, max_results: 10 });
            const search = extractJSON(String(searchRaw)) || null;
            const results = Array.isArray(search?.results) ? search.results : [];
            const fromChannel = (!allowOtherChannels && channelHint)
                ? results.filter(r => String(r?.channel || "").toLowerCase().includes(channelHint))
                : results;

            const synth = fromChannel.slice(0, 4).map(r => ({ title: r.title, url: r.url, channel: r.channel }));
            for (const c of synth) {
                const url = String(c?.url || "").trim();
                if (!isValidPlatformUrl("youtube", url)) continue;
                if (runState.cache.youtube_candidates_tried.includes(url)) continue;

                runState.cache.youtube_candidates_tried.push(url);
                await openUrlInChromeSameTab(url);
                await applyChromeTabHygiene();
                await new Promise(r => setTimeout(r, 320));
                try {
	                    if (tools.chrome_wait) {
	                        await tools.chrome_wait({
	                            predicate_js:
	                                "!!location.hostname && location.hostname.includes('youtube') && " +
	                                "((location.pathname==='/watch') || location.pathname.startsWith('/shorts/')) && " +
	                                "(function(){const h=document.querySelector(\"h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h1 yt-formatted-string\");" +
	                                "const ht=h?String(h.textContent||'').trim():'';" +
	                                "const dt=String(document.title||'').trim();" +
	                                "return ht.length>0 && dt.length>0;})()",
	                            timeout_ms: 9000,
	                            interval_ms: 180
	                        });
	                    }
	                } catch {}

                let status = null;
                if (tools.youtube_get_status) {
                    const statusRaw = await tools.youtube_get_status({});
                    status = extractJSON(String(statusRaw)) || null;
                    if (isHardUnavailableStatus(status)) {
                        unavailableCandidateCount++;
                        const reason = String(status?.reason || "").trim();
                        if (reason) unavailableReasons.add(reason);
                        continue;
                    }
                }

	                const meta = await getYouTubeMetaWithRetry(4);
                if (meta && meta.ok === true && meta.is_watch === true) {
                    const title = String(meta.title || "").toLowerCase();
                    const desc = String(meta.description || "").toLowerCase();
                    const channel = String(meta.channel || "").toLowerCase();

                    if (!allowOtherChannels && channelHint && channel && !channel.includes(channelHint)) {
                        continue;
                    }
                    if (requireVlog2 && !title.includes("vlog") && !desc.includes("vlog")) {
                        continue;
                    }
                    const kwOk = keywords.length === 0
                        ? true
                        : keywords.every((kw) => {
                              const k = String(kw || "").toLowerCase();
                              if (!k) return true;
                              return title.includes(k) || desc.includes(k) || fuzzyKeywordMatch(title, k) || fuzzyKeywordMatch(desc, k);
                          });
                    const expectedTitle = String(c?.title || "").trim();
                    const titleOk = expectedTitle ? titleMatchOk(expectedTitle, meta.title || "") : false;
                    const earliestOk = !earliestRequested || earliestTitleHintOk(meta.title || expectedTitle);
                    if ((!titleOk && !kwOk) || (earliestRequested && !earliestOk && keywords.length === 0)) continue;

                    lastPlayable = { url, title: meta.title || c?.title || "", channel: meta.channel || c?.channel || "" };
                    runState.cache.youtube_last_playable = lastPlayable;
                    runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || url;
                    return { ok: true, url, title: meta.title || c?.title || "", channel: meta.channel || c?.channel || "" };
                }

                if (status && status.ok === true && status.available === true) {
                    lastPlayable = { url, title: String(c?.title || ""), channel: String(c?.channel || "") };
                    runState.cache.youtube_last_playable = lastPlayable;
                    runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || url;
                    return { ok: true, url, title: String(c?.title || ""), channel: String(c?.channel || "") };
                }
            }
            return null;
        };

        const parts = [];
        if (channelHint) parts.push(channelHint);
        if (keywords.length) parts.push(...keywords);
        if (!keywords.length && wantsVlog(goal)) parts.push("vlog");
        const query = parts.join(" ").trim();
        if (query) {
            const hit = await trySearch(query);
            if (hit) return hit;
        }

        // Secondary search using the best title hint from Gemini candidates (often accurate even when URLs are wrong).
        const titleHint = String((candidates || []).map(c => c?.title).filter(Boolean).sort((a,b)=>String(b).length-String(a).length)[0] || "").trim();
        if (titleHint && channelHint) {
            const q2 = `${channelHint} ${titleHint}`.slice(0, 120);
            const hit2 = await trySearch(q2);
            if (hit2) return hit2;
        }
        if (titleHint && !channelHint) {
            const q3 = String(titleHint).slice(0, 120);
            const hit3 = await trySearch(q3);
            if (hit3) return hit3;
        }
    }

    if (unavailableCandidateCount > 0) {
        const reasonLine = Array.from(unavailableReasons).join(", ") || "unavailable/private";
        return {
            ok: false,
            question:
                `That YouTube target appears unavailable/private (${reasonLine}).\n` +
                `Reply with one option:\n` +
                `0) "search reupload"\n` +
                `1) "latest" (different/latest public match)\n` +
                `2) a specific YouTube URL\n` +
                `3) a more exact video title`
        };
    }

    const titles = (candidates || []).slice(0, 5).map((c) => `${c?.title || ""} (${c?.url || ""})`).filter(Boolean).join("\n");
    const playableLine = lastPlayable?.url
        ? `\n\nI did open a playable YouTube watch page, but couldn't confidently match it:\n- ${String(lastPlayable.title || "").slice(0, 120)}\n- ${lastPlayable.url}\nReply with: "use current" to proceed with this open video.\n`
        : "";
    return {
        ok: false,
        question:
            `I couldn't confidently match a YouTube video to your request.\n` +
            (titles ? `Tried candidates:\n${titles}\n\n` : "") +
            playableLine +
            `Reply with one option:\n` +
            `0) "use current" (use the currently opened playable video)\n` +
            `1) "search reupload" (I will search other channels)\n` +
            `2) "latest" (I will open the latest public matching video)\n` +
            `3) a specific YouTube URL\n` +
            `4) a more exact video title`
    };
}

function isInstagramGoal(goal = "") {
    return inferMediaPlatform(goal) === "instagram";
}

function isInstagramPostGoal(goal = "") {
    const g = goal.toLowerCase();
    // Treat "comment" misspellings as intent to operate on a post.
    return (
        isInstagramGoal(g) &&
        (g.includes("post") || g.includes("reel") || g.includes("latest") || /(comment|commont|coment|commet|commment)\b/i.test(g))
    );
}

function isInstagramCommentGoal(goal = "") {
    const g = goal.toLowerCase();
    // Common misspellings seen in Telegram: "commont", "coment", "commet"
    return isInstagramPostGoal(g) && /(comment|commont|coment|commet|commment)\b/i.test(g);
}

function isYouTubeCommentGoal(goal = "") {
    const g = goal.toLowerCase();
    return inferMediaPlatform(g) === "youtube" && /(comment|commont|coment|commet|commment)\b/i.test(g);
}

function wantsQuoteFromVideo(goal = "") {
    const g = String(goal || "").toLowerCase();
    return g.includes("quote") || g.includes("dialogue") || g.includes("line which he has said") || g.includes("line from the video");
}

function getLatestHelperState(runState = null) {
    return runState?.cache?.helperThinking?.value || null;
}

function helperExpectsQuote(runState = null) {
    const helper = getLatestHelperState(runState);
    const artifacts = Array.isArray(helper?.requiredArtifacts) ? helper.requiredArtifacts : [];
    if (!artifacts.length) return false;
    for (const a of artifacts) {
        const name = String(a?.name || "").toLowerCase();
        const detail = String(a?.detail || "").toLowerCase();
        const status = String(a?.status || "unknown").toLowerCase();
        const mentionsQuote = name.includes("quote") || detail.includes("quote") || detail.includes("dialogue");
        if (!mentionsQuote) continue;
        if (status === "not_needed" || status === "optional") continue;
        return true;
    }
    return false;
}

function allowsNoQuote(goal = "") {
    const g = String(goal || "").toLowerCase();
    return g.includes("without quote") || g.includes("no quote") || g.includes("skip quote");
}

function pickTranscriptQuoteFallback(transcript = "") {
    const lines = String(transcript || "")
        .split(/\n+/)
        .map((line) => String(line || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    for (const line of lines) {
        if (line.length < 18 || line.length > 120) continue;
        if (/^\d+:\d+/.test(line)) continue;
        if (!/[a-z]/i.test(line)) continue;
        return line.slice(0, 120);
    }

    const sentences = String(transcript || "")
        .replace(/\s+/g, " ")
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    for (const s of sentences) {
        if (s.length < 18 || s.length > 120) continue;
        return s;
    }
    return null;
}

async function buildSuggestedComment(goal = "") {
    try {
        const prompt = `You generate one concise positive social-media comment for an automation agent.
Return JSON only:
{"topic_hint":"...","comment":"..."}
Rules:
- comment must be under 140 characters
- no hashtags
- no emojis
- keep it natural and relevant to the request
User request: ${goal}`;
        const response = await getAi().models.generateContent({
            model: VALIDATOR_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = extractJSON(text) || JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
        const topicHint = String(parsed?.topic_hint || "").trim();
        const comment = String(parsed?.comment || "").trim();
        if (!comment) return null;
        return { topicHint, comment: comment.slice(0, 140) };
    } catch {
        return {
            topicHint: "",
            comment: "Great post and really well done. This was insightful and inspiring to read."
        };
    }
}

async function buildSuggestedQuoteFromTranscript(goal = "") {
    try {
        // Assumes a YouTube watch page is open in Chrome.
        if (!tools.youtube_get_transcript || global.chromeJsDisabled) return null;
        const raw = await tools.youtube_get_transcript({ max_chars: 7000 });
        const parsed = (() => {
            try { return JSON.parse(String(raw || "")); } catch { return null; }
        })();
        if (!parsed?.ok || !parsed?.text) return null;
        const transcript = String(parsed.text);
        const fallbackQuote = pickTranscriptQuoteFallback(transcript);

        try {
            const prompt = `Pick one short, safe, positive quote line from this transcript that sounds like the creator speaking.
Return JSON only: {"quote":"..."}.
Rules:
- under 120 characters
- must be an exact substring from the transcript (verbatim)
- do not include timestamps
TRANSCRIPT:
${transcript}`;
            const response = await getAi().models.generateContent({
                model: VALIDATOR_MODEL,
                contents: [{ role: "user", parts: [{ text: prompt }] }]
            });
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
            const parsedQuote = extractJSON(text) || JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
            const quote = String(parsedQuote?.quote || "").trim();
            if (quote && transcript.includes(quote)) return quote.slice(0, 120);
        } catch {}
        return fallbackQuote;
    } catch {
        return null;
    }
}

async function ensureYouTubeQuoteIfRequested(goal = "", runState = null) {
    let nextGoal = String(goal || "");
    const helperNeedsQuote = helperExpectsQuote(runState);
    const lexicalNeedsQuote = wantsQuoteFromVideo(nextGoal);
    if (!isYouTubeCommentGoal(nextGoal) || !(helperNeedsQuote || lexicalNeedsQuote)) {
        return { goal: nextGoal, askUser: false, question: "" };
    }
    if (/SUGGESTED_QUOTE:/i.test(nextGoal)) {
        return { goal: nextGoal, askUser: false, question: "" };
    }
    if (allowsNoQuote(nextGoal)) {
        return { goal: nextGoal, askUser: false, question: "" };
    }

    runState = runState || { cache: Object.create(null), goalRaw: nextGoal };
    runState.cache = runState.cache || Object.create(null);

    const cachedQuote = String(runState.cache.suggestedQuote || "").trim();
    const quote = cachedQuote || (await buildSuggestedQuoteFromTranscript(nextGoal));
    if (!quote) {
        return {
            goal: nextGoal,
            askUser: true,
            question: 'I could not extract a reliable quote from the current video transcript. Reply with a quote to include, or reply "continue without quote".'
        };
    }

    runState.cache.suggestedQuote = quote;
    nextGoal = `${nextGoal}\nSUGGESTED_QUOTE: ${quote}`;
    runState.goalRaw = nextGoal;
    return { goal: nextGoal, askUser: false, question: "" };
}

function extractPostIndexFromGoal(goal = "") {
    const g = goal.toLowerCase();
    const numericOrdinal = g.match(/\b(\d+)(?:st|nd|rd|th)?\s*(?:latest|newest)?\s*(?:post|reel|video)?\b/);
    if (numericOrdinal) return Math.max(1, parseInt(numericOrdinal[1], 10) || 1);

    const wordToIndex = {
        first: 1,
        second: 2,
        third: 3,
        fourth: 4,
        fifth: 5,
        sixth: 6,
        seventh: 7,
        eighth: 8,
        ninth: 9,
        tenth: 10,
        eleventh: 11,
        twelfth: 12,
        thirteenth: 13,
        fourteenth: 14,
        fifteenth: 15,
        sixteenth: 16,
        seventeenth: 17,
        eighteenth: 18,
        nineteenth: 19,
        twentieth: 20
    };
    const wordMatch = g.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\b/);
    if (wordMatch && wordToIndex[wordMatch[1]]) {
        return wordToIndex[wordMatch[1]];
    }

    if (g.includes("latest") || g.includes("newest") || g.includes("first")) return 1;
    return 1;
}

function extractInstagramUsernameFromText(text = "") {
    const at = text.match(/@([a-z0-9._]+)/i);
    if (at) return at[1];

    const url = text.match(/instagram\.com\/([a-z0-9._]+)/i);
    if (url) return url[1];

    return null;
}

function extractInstagramUsernameFromUrl(url = "") {
    try {
        const u = new URL(url);
        const first = (u.pathname || "").split("/").filter(Boolean)[0];
        if (!first || first === "p" || first === "reel" || first === "explore") return null;
        return first;
    } catch {
        return null;
    }
}

function recentMouseSpamCount(history = []) {
    const recent = history.slice(-6);
    return recent.filter(a => a.action === "move" || a.action === "click").length;
}

function actionFingerprint(entry) {
    if (!entry || !entry.action) return "";
    const action = entry.action;
    const args = entry.args || {};

    if (action === "key_repeat" && String(args.key || "").toLowerCase() === "tab") {
        return `tab:${getRepeatCount(args, 1)}`;
    }
    if (action === "key_combo_repeat" && String(args.keys || "").toLowerCase() === "shift+tab") {
        return `shift-tab:${getRepeatCount(args, 1)}`;
    }
    if (action === "key_combo" && String(args.keys || "").toLowerCase() === "tab") {
        return "tab:1";
    }
    if (action === "key_combo" && String(args.keys || "").toLowerCase() === "shift+tab") {
        return "shift-tab:1";
    }
    if (action === "move") return "move";
    if (action === "click") return "click";
    if (action === "shell") return `shell:${String(args.command || "").trim()}`;

    return `${action}:${JSON.stringify(args)}`;
}

function consecutiveRepetitionInfo(history = []) {
    if (!history.length) return { count: 0, fingerprint: "" };
    const last = history[history.length - 1];
    const fp = actionFingerprint(last);
    if (!fp) return { count: 0, fingerprint: "" };

    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        if (actionFingerprint(history[i]) === fp) count++;
        else break;
    }
    return { count, fingerprint: fp };
}

function getRepeatCount(args = {}, fallback = 1) {
    const raw = args?.count ?? args?.times ?? args?.repeats ?? args?.repeat ?? args?.n;
    const parsed = parseInt(raw, 10);
    return Math.max(1, Number.isFinite(parsed) ? parsed : fallback);
}

function hasExplicitRepeatCount(args = {}) {
    return (
        args?.count !== undefined ||
        args?.times !== undefined ||
        args?.repeats !== undefined ||
        args?.repeat !== undefined ||
        args?.n !== undefined
    );
}

function adaptiveTabCount(history = [], direction = "forward") {
    const recent = history.slice(-10);
    let similar = 0;
    let lastCount = 0;

    for (let i = recent.length - 1; i >= 0; i--) {
        const entry = recent[i];
        const isForward =
            (entry.action === "key_repeat" && String(entry.args?.key || "").toLowerCase() === "tab") ||
            (entry.action === "key_combo_repeat" && String(entry.args?.keys || "").toLowerCase() === "tab") ||
            (entry.action === "key" && String(entry.args?.key || "").toLowerCase() === "tab") ||
            (entry.action === "key_combo" && String(entry.args?.keys || "").toLowerCase() === "tab");
        const isBackward =
            (entry.action === "key_combo_repeat" && String(entry.args?.keys || "").toLowerCase() === "shift+tab") ||
            (entry.action === "key_combo" && String(entry.args?.keys || "").toLowerCase() === "shift+tab");

        if ((direction === "forward" && isForward) || (direction === "backward" && isBackward)) {
            similar++;
            const c = getRepeatCount(entry.args, 1);
            if (c > 1 && lastCount === 0) lastCount = c;
        } else {
            break;
        }
    }

    const base = direction === "forward" ? 3 : 2;
    if (lastCount > 1) {
        return Math.max(base, Math.min(20, Math.round(lastCount * 0.85)));
    }
    return Math.max(base, Math.min(20, base + similar * 2));
}

function recentSameShellCount(history = [], command = "") {
    if (!command) return 0;
    const recent = history.slice(-8);
    return recent.filter(a => a.action === "shell" && String(a.args?.command || "") === command).length;
}

function recentTabForwardCount(history = []) {
    const recent = history.slice(-8);
    return recent.filter(a =>
        (a.action === "key_repeat" && String(a.args?.key || "").toLowerCase() === "tab") ||
        (a.action === "key" && String(a.args?.key || "").toLowerCase() === "tab") ||
        (a.action === "key_combo" && String(a.args?.keys || "").toLowerCase() === "tab")
    ).length;
}

function recentTabBackwardCount(history = []) {
    const recent = history.slice(-8);
    return recent.filter(a =>
        (a.action === "key_combo_repeat" && String(a.args?.keys || "").toLowerCase() === "shift+tab") ||
        (a.action === "key_combo" && String(a.args?.keys || "").toLowerCase() === "shift+tab")
    ).length;
}

function recentTabForwardPresses(history = []) {
    const recent = history.slice(-8);
    let presses = 0;
    for (const a of recent) {
        if (a.action === "key_repeat" && String(a.args?.key || "").toLowerCase() === "tab") {
            presses += getRepeatCount(a.args, 1);
        } else if (a.action === "key_combo_repeat" && String(a.args?.keys || "").toLowerCase() === "tab") {
            presses += getRepeatCount(a.args, 1);
        } else if (a.action === "key" && String(a.args?.key || "").toLowerCase() === "tab") {
            presses += 1;
        } else if (a.action === "key_combo" && String(a.args?.keys || "").toLowerCase() === "tab") {
            presses += 1;
        }
    }
    return presses;
}

function recentTabBackwardPresses(history = []) {
    const recent = history.slice(-8);
    let presses = 0;
    for (const a of recent) {
        if (a.action === "key_combo_repeat" && String(a.args?.keys || "").toLowerCase() === "shift+tab") {
            presses += getRepeatCount(a.args, 1);
        } else if (a.action === "key_combo" && String(a.args?.keys || "").toLowerCase() === "shift+tab") {
            presses += 1;
        }
    }
    return presses;
}

function recentSameForwardTabPlanCount(history = [], plannedCount = 1) {
    const recent = history.slice(-6);
    return recent.filter(a =>
        a.action === "key_repeat" &&
        String(a.args?.key || "").toLowerCase() === "tab" &&
        (getRepeatCount(a.args, 1) === plannedCount)
    ).length;
}

function isForwardTabAction(actionPlan) {
    if (!actionPlan || !actionPlan.action) return false;
    return (
        actionPlan.action === "tab" ||
        (actionPlan.action === "key" && String(actionPlan.args?.key || "").toLowerCase() === "tab") ||
        (actionPlan.action === "key_repeat" && String(actionPlan.args?.key || "").toLowerCase() === "tab") ||
        (actionPlan.action === "key_combo" && String(actionPlan.args?.keys || "").toLowerCase() === "tab") ||
        (actionPlan.action === "key_combo_repeat" && String(actionPlan.args?.keys || "").toLowerCase() === "tab")
    );
}

function isBackwardTabAction(actionPlan) {
    if (!actionPlan || !actionPlan.action) return false;
    return (
        (actionPlan.action === "key_combo" && String(actionPlan.args?.keys || "").toLowerCase() === "shift+tab") ||
        (actionPlan.action === "key_combo_repeat" && String(actionPlan.args?.keys || "").toLowerCase() === "shift+tab")
    );
}

function isPageScrollAction(actionPlan) {
    if (!actionPlan || !actionPlan.action) return false;
    if (actionPlan.action === "key" && ["pagedown", "pageup"].includes(String(actionPlan.args?.key || "").toLowerCase())) {
        return true;
    }
    if (actionPlan.action === "key_combo" && ["pagedown", "pageup"].includes(String(actionPlan.args?.keys || "").toLowerCase())) {
        return true;
    }
    return false;
}

function recentInstagramDomActionCount(history = []) {
    const recent = history.slice(-8);
    return recent.filter(a => String(a.action || "").startsWith("instagram_")).length;
}

function recentTabNavigationActionCount(history = []) {
    const recent = history.slice(-8);
    return recent.filter(a =>
        (a.action === "key_repeat" && String(a.args?.key || "").toLowerCase() === "tab") ||
        (a.action === "key_combo_repeat" && String(a.args?.keys || "").toLowerCase() === "shift+tab") ||
        (a.action === "key" && String(a.args?.key || "").toLowerCase() === "tab") ||
        (a.action === "key_combo" && String(a.args?.keys || "").toLowerCase() === "tab") ||
        (a.action === "key_combo" && String(a.args?.keys || "").toLowerCase() === "shift+tab")
    ).length;
}

function isEnterAction(entry) {
    if (!entry || !entry.action) return false;
    if (entry.action === "enter") return true;
    if (entry.action === "key" && String(entry.args?.key || "").toLowerCase() === "enter") return true;
    if (entry.action === "key_combo" && String(entry.args?.keys || "").toLowerCase() === "enter") return true;
    return false;
}

function isCommentShortcutAction(entry) {
    if (!entry || !entry.action) return false;
    if (entry.action === "key" && String(entry.args?.key || "").toLowerCase() === "c") return true;
    if (entry.action === "key_combo" && String(entry.args?.keys || "").toLowerCase() === "c") return true;
    return false;
}

function normalizeKeyboardNavigationAction(actionPlan) {
    // IMPORTANT:
    // Do not auto-scale tab counts. The planner should decide counts explicitly.
    // We only normalize "tab"/"shift+tab" single presses into counted tools with count=1.
    if (!actionPlan || !actionPlan.action) return actionPlan;

    if (actionPlan.action === "tab") {
        return { action: "key_repeat", args: { key: "tab", count: 1 } };
    }
    if (actionPlan.action === "key" && String(actionPlan.args?.key || "").toLowerCase() === "tab") {
        return { action: "key_repeat", args: { key: "tab", count: 1 } };
    }
    if (actionPlan.action === "key_combo" && String(actionPlan.args?.keys || "").toLowerCase() === "tab") {
        return { action: "key_repeat", args: { key: "tab", count: 1 } };
    }
    if (actionPlan.action === "key_combo" && String(actionPlan.args?.keys || "").toLowerCase() === "shift+tab") {
        return { action: "key_combo_repeat", args: { keys: "shift+tab", count: 1 } };
    }

    if (actionPlan.action === "key_repeat" && String(actionPlan.args?.key || "").toLowerCase() === "tab") {
        const count = hasExplicitRepeatCount(actionPlan.args) ? getRepeatCount(actionPlan.args, 1) : 1;
        return { action: "key_repeat", args: { key: "tab", count } };
    }
    if (actionPlan.action === "key_combo_repeat" && String(actionPlan.args?.keys || "").toLowerCase() === "shift+tab") {
        const count = hasExplicitRepeatCount(actionPlan.args) ? getRepeatCount(actionPlan.args, 1) : 1;
        return { action: "key_combo_repeat", args: { keys: "shift+tab", count } };
    }

    return actionPlan;
}

function isRepeatedTerminalSpotlight(actionHistory = []) {
    const recent = actionHistory.slice(-6);
    let spotlightCount = 0;
    for (const act of recent) {
        if (act.action === "spotlight_search" && act.args?.query?.toLowerCase().includes("terminal")) {
            spotlightCount++;
        }
    }
    return spotlightCount >= 2;
}

async function getShortcutCached(appName, intention) {
    global.shortcutCache = global.shortcutCache || {};
    const key = `${appName}|${intention}`;
    if (global.shortcutCache[key]) return global.shortcutCache[key];
    if (!tools.find_shortcuts) return null;
    const shortcut = await tools.find_shortcuts({ app_name: appName, intention });
    global.shortcutCache[key] = shortcut;
    return shortcut;
}

async function ensureShortcutList(appName) {
    global.shortcutListCache = global.shortcutListCache || {};
    if (global.shortcutListCache[appName]) return global.shortcutListCache[appName];
    if (!tools.list_shortcuts) return null;
    const list = await tools.list_shortcuts({ app_name: appName });
    global.shortcutListCache[appName] = list;
    return list;
}

function deriveShortcutAppContext(activeApp = "", activeUrl = "") {
    const app = String(activeApp || "").trim();
    const url = String(activeUrl || "").trim();
    const lowerApp = app.toLowerCase();
    const lowerUrl = url.toLowerCase();

    if (lowerApp.includes("chrome")) {
        if (lowerUrl.includes("instagram.com")) {
            return { key: "Google Chrome|instagram.com", label: "Instagram Web (Google Chrome)" };
        }
        if (lowerUrl.includes("youtube.com") || lowerUrl.includes("youtu.be")) {
            return { key: "Google Chrome|youtube.com", label: "YouTube Web (Google Chrome)" };
        }
        if (lowerUrl.includes("x.com") || lowerUrl.includes("twitter.com")) {
            return { key: "Google Chrome|x.com", label: "X Web (Google Chrome)" };
        }
        if (lowerUrl.includes("web.whatsapp.com")) {
            return { key: "Google Chrome|web.whatsapp.com", label: "WhatsApp Web (Google Chrome)" };
        }
        return { key: "Google Chrome|generic", label: "Google Chrome" };
    }

    if (lowerApp.includes("safari")) {
        if (lowerUrl.includes("instagram.com")) {
            return { key: "Safari|instagram.com", label: "Instagram Web (Safari)" };
        }
        if (lowerUrl.includes("youtube.com") || lowerUrl.includes("youtu.be")) {
            return { key: "Safari|youtube.com", label: "YouTube Web (Safari)" };
        }
        return { key: "Safari|generic", label: "Safari" };
    }

    if (!app) return { key: "unknown", label: "unknown" };
    return { key: app, label: app };
}

function getDefaultMacShortcuts() {
    return [
        { action: "Copy", shortcut: "cmd+c" },
        { action: "Paste", shortcut: "cmd+v" },
        { action: "Find", shortcut: "cmd+f" },
        { action: "Reload", shortcut: "cmd+r" },
        { action: "Address Bar/Search", shortcut: "cmd+l" },
        { action: "New Tab", shortcut: "cmd+t" },
        { action: "Close Tab", shortcut: "cmd+w" },
        { action: "Switch App", shortcut: "cmd+tab" }
    ];
}

function parseShortcutList(listRaw) {
    if (!listRaw) return [];
    const text = String(listRaw).trim();
    if (!text || text === "error") return [];
    try {
        const arr = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function buildRelevantShortcuts(shortcuts = [], goal = "", max = 8) {
    const g = String(goal || "").toLowerCase();
    const tokens = g.split(/[^a-z0-9]+/).filter(Boolean);
    const boosted = [];
    const fallback = [];
    for (const s of shortcuts) {
        const action = String(s?.action || "").toLowerCase();
        const score = tokens.reduce((acc, t) => acc + (action.includes(t) ? 1 : 0), 0);
        if (score > 0) boosted.push({ score, item: s });
        else fallback.push(s);
    }
    boosted.sort((a, b) => b.score - a.score);
    const selected = boosted.map(x => x.item);
    for (const f of fallback) {
        if (selected.length >= max) break;
        selected.push(f);
    }
    return selected.slice(0, max);
}

async function getShortcutContextForScreen(userGoal, screenshotBase64) {
    try {
        let activeApp = null;
        if (tools.get_active_app) {
            activeApp = await tools.get_active_app();
        }
        let activeUrl = "";
        if (tools.get_active_browser_url && /chrome|safari/i.test(String(activeApp || ""))) {
            activeUrl = await tools.get_active_browser_url();
        }

        const context = deriveShortcutAppContext(activeApp, activeUrl);
        const cacheKey = context.key;

        global.shortcutContextCache = global.shortcutContextCache || {};
        const now = Date.now();
        const ttl = CONFIG.SHORTCUT_CONTEXT_CACHE_TTL_MS || 10 * 60 * 1000;
        const memCached = global.shortcutContextCache[cacheKey];
        if (memCached && (now - memCached.ts) < ttl) {
            return memCached.data;
        }

        const cacheDir = path.join(os.homedir(), ".ai-agent");
        const cachePath = path.join(cacheDir, "shortcut_cache.json");
        if (fs.existsSync(cachePath)) {
            try {
                const fileCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
                const hit = fileCache[cacheKey];
                if (hit) {
                    global.shortcutContextCache[cacheKey] = { ts: now, data: hit };
                    return hit;
                }
            } catch {}
        }

        let shortcuts = [];
        if (tools.list_shortcuts) {
            const rawList = await tools.list_shortcuts({ app_name: context.label });
            shortcuts = parseShortcutList(rawList);
        }

        const macos = getDefaultMacShortcuts();
        const relevant = buildRelevantShortcuts(shortcuts, userGoal, 8);
        const data = {
            app: context.label,
            active_app: activeApp || "unknown",
            active_url: activeUrl || "",
            shortcuts,
            macos,
            relevant
        };

        global.shortcutContextCache[cacheKey] = { ts: now, data };
        try {
            const existing = fs.existsSync(cachePath)
                ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
                : {};
            existing[cacheKey] = data;
            fs.writeFileSync(cachePath, JSON.stringify(existing, null, 2));
        } catch {}

        return data;
    } catch (e) {
        console.error("Shortcut context error:", e.message);
        return { app: "unknown", shortcuts: [], macos: [], relevant: [] };
    }
}


// Global tracker instance
global.stepTracker = new AgentStepTracker();


// ⚙️ CONFIGURATION CONSTANTS
const CONFIG = {
    MAX_RETRIES: 3,
    BASE_DELAY: 1000,
    MODEL_NAME: "gemini-3-flash-preview",
    HYDE_MODEL_NAME: "gemini-3-flash-preview",
    HELPER_MODEL_NAME: "gemini-3-flash-preview",
    JITTER_THRESHOLD_PX: 15,
    LOOP_DETECTION_RADIUS_PX: 50,
    ACTION_HISTORY_LIMIT: 20,
    SPOTLIGHT_DELAY_MS: 1200,
    SCREENSHOT_DELAY_MS: 500,
    HTTP_OVERLOAD_STATUS: 503,
    SHORTCUT_CONTEXT_CACHE_TTL_MS: 10 * 60 * 1000,
    MEMORY_SEARCH_CACHE_TTL_MS: 15 * 1000,
    MEMORY_WRITE_MIN_INTERVAL_MS: 4000,
    HYDE_CACHE_TTL_MS: 60 * 1000,
    HELPER_CACHE_TTL_MS: 15 * 1000,
    HELPER_DEBUG_LOGS: String(process.env.HELPER_DEBUG_LOGS || "false").toLowerCase() === "true",
    HELPER_TRACE_MAX_CHARS: Math.max(200, Math.min(2000, parseInt(process.env.HELPER_TRACE_MAX_CHARS, 10) || 700))
};

// 🔄 RETRY HELPER FUNCTION
async function retryWithBackoff(apiCall, maxRetries = CONFIG.MAX_RETRIES, baseDelay = CONFIG.BASE_DELAY) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await apiCall();
        } catch (error) {
            if (error.code === CONFIG.HTTP_OVERLOAD_STATUS || error.message?.includes('overloaded')) {
                if (attempt === maxRetries) {
                    throw new Error(`Gemini API overloaded after ${maxRetries} attempts. Please try again in a few minutes.`);
                }

                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.log(`⏳ Gemini API overloaded (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
}

// 🔒 GLOBAL STATE TRACKING FOR PROTOCOL ENFORCEMENT
let lastActionType = null;
let lastActionArgs = null;
let actionHistory = [];

// [FIX] Reset memory at module load/start
memory.resetSession();

const PLANNER_PROMPT = `You are a computer action planner. Analyze the screenshot and output ONE next action in JSON only.

Output format:
{"action":"ACTION_NAME","args":{"param":"value"}}

Hard rules:
- Terminal-first: if a shell command can do the step, use shell/open_app/open_url/mdfind.
- Never use Spotlight/Finder for file or folder operations.
- Do NOT use shell to run UI automation (osascript/System Events/key codes). Use key/key_repeat/key_combo tools instead.
- Do NOT use shell to run Chrome automation via osascript/javascript. Use chrome_* DOM tools (or chrome_eval) instead.
- Use Google Chrome for all web tasks. Do NOT use Arc/Safari/Firefox because DOM tools are wired to Google Chrome Apple Events.
- Keyboard-first navigation is allowed for native apps, but for web apps in Chrome you MUST use DOM-first tools (chrome_* / instagram_*).
- Do not use key_combo for single keys like tab.
- Mouse tools are disabled in this runtime. Do not output move/click.
- If Terminal is already open, do not reopen it.
- If the goal requests media from YouTube/Instagram and URL is known/resolved, prefer open_url or shell open.
- For ANY web page task in Chrome, prefer DOM-first tools (fast, reliable, no mouse):
  - chrome_get_context (understand where you are)
  - chrome_list (inspect candidate buttons/links/inputs)
  - chrome_click (click by label/text/href)
  - chrome_focus + chrome_type (fill forms, search boxes, comments)
  - chrome_extract (read text for verification)
  - chrome_wait (wait for page state)
- For Instagram browsing, prefer DOM-level tools before tab loops:
  - instagram_open_post
  - instagram_navigate_post
  - instagram_focus_comment
  - instagram_post_comment
  - instagram_get_post_caption
  - chrome_eval (if needed)
- For Instagram post/comment goals:
  - First try instagram_open_post (index_from_latest from user request).
  - If you are inside a post, use instagram_navigate_post for left/right movement.
  - For comment entry/posting, prefer instagram_post_comment if you have the comment text.
  - Otherwise, prefer instagram_focus_comment, then type, then submit.
  - Do NOT use tab/shift+tab for Instagram. If DOM tools fail, use chrome_get_context/chrome_list to re-target, or stop with a clear blocker.
  - If Chrome JS automation is blocked, you should stop and ask user to enable it (don't tab-spam).
  - If GOAL contains "SUGGESTED_COMMENT:", you MUST submit that exact comment (via instagram_post_comment or focused typing).

Question policy:
- Ask user only for hard blockers: OTP/CAPTCHA, missing credentials, or explicit user choice that cannot be inferred.
- Do not ask whether user is logged in if screenshot already indicates a usable logged-in UI.
- Do not ask for positive-comment wording if sentiment is implied; draft one.

Document extraction:
- For vague document tasks, first list candidates with find_candidate_docs.
- Extract with gemini_extract_text after user confirms file.
- Use EXTRACTED_FIELDS_JSON when present.

If unsure, return a wait step:
{"action":"wait","args":{"ms":1000}}`;


// 🔧 Helper function to extract JSON from text
function extractJSON(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    // Strategy 1: Try to find JSON code block
    const codeMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (codeMatch) {
        try {
            return JSON.parse(codeMatch[1]);
        } catch (e) {
            // ignore
        }
    }

    // Strategy 2: Find first { and parse
    const firstBrace = text.indexOf('{');
    if (firstBrace !== -1) {
        let currentText = text.substring(firstBrace);
        let stack = 0;
        let endIndex = -1;
        let inString = false;
        let escape = false;

        for (let i = 0; i < currentText.length; i++) {
            const char = currentText[i];

            if (escape) {
                escape = false;
                continue;
            }

            if (char === '\\') {
                escape = true;
                continue;
            }

            if (char === '"' && !escape) {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    stack++;
                } else if (char === '}') {
                    stack--;
                    if (stack === 0) {
                        endIndex = i;
                        break;
                    }
                }
            }
        }

        if (endIndex !== -1) {
            const jsonStr = currentText.substring(0, endIndex + 1);
            try {
                return JSON.parse(jsonStr);
            } catch (e) {
                // ignore
            }
        }
    }

    return null;
}

// 🕵️ VERIFIER SYSTEM PROMPT (Quality Assurance)
const VERIFIER_PROMPT = `You are a supervisor AI (Quality Assurance). Your job is to VERIFY the proposed action from the "Planner" agent.

INPUTS:
1. User Goal
2. Screenshot of the current screen
3. Proposed Action (JSON)

YOUR RESPONSIBILITIES:
1. **LOGIC CHECK (PINNED POSTS)**:
   - **CRITICAL RULE**: If the user wants "latest" or "newest", **NEVER** click a Pinned Post.
   - **INSPECTION**: Look at the top row. Do they have a "Pin" icon (📌) or "Pinned" text?
   - **REJECTION**: If the coordinates target a Pinned Post, **REJECT** the plan immediately.
   - **REASONING**: "User wants latest post. First 3 posts are Pinned. Target must be the 4th post."
   - **ABSOLUTE BAN**: Do NOT accept "it is standard to click the first post". Pinned posts are OLD. 
   - **VERDICT**: If it is Pinned -> REJECT.

2. **COORDINATE SANITY CHECK (CRITICAL)**:
   - **SIDEBAR GUARD**: The Left Sidebar (Instagram/Twitter) is typically X < 250px.
     - **IF** the User Goal is to click a "Post", "Picture", "Comment", or "Feed Item":
     - **AND** proposed X coordinate is < 250 (e.g., 40, 50, 100):
     - **THEN** REJECT IMMEDIATELY.
     - **REASON**: "You are clicking the Sidebar. The feed is in the CENTER. You need to verify the content location."
     - **CORRECTION**: Suggest a DRASTIC increase in X (e.g., X = 400 or 500). Do NOT suggest small changes.
   - **GHOST CLICKING**: Does the target location actually contain a button/link? Or is it empty whitespace?
   - **OFF-SCREEN**: Reject negative coordinates or coordinates larger than screen size.

   - **OFF-SCREEN**: Reject negative coordinates or coordinates larger than screen size.

3. **PROTOCOL: KEYBOARD OVER MOUSE**:
   - **RULE**: If the user wants to Search, Refresh, or Navigate, and the Plan is "move"/"click", ASK: "Is there a shortcut?"
   - **Examples**:
     - Search (General) -> Use spotlight_search tool.
     - Search (In-App) -> Suggest 'cmd+k' or 'cmd+f'.
     - Refresh -> Suggest 'cmd+r'.
     - Address Bar -> Suggest 'cmd+l'.
   - **ACTION**: If a common shortcut exists, **REJECT or MODIFY** the plan to use 'key_combo'.
   - **REASON**: "Keyboard shortcuts are more reliable than mouse clicks."

4. **LOOP DETECTION & SHORTCUT ENFORCEMENT**:
   - Does this action look exactly like a failed previous action?
   - Has the Planner tried to "move" to the same approximate area 3 times without success?
   - **IF YES**:
     - **REJECT** the move.
     - **REASON**: "Mouse positioning is failing (Loop detected)."
     - **CORRECTION**: Suggest **KEYBOARD NAVIGATION** (Shortcuts first, then Tab).
       - '{"action": "key", "args": {"key": "tab"}}'
     - **EXPLANATION**: "Use SHORTCUTS or TAB to reach the target."

OUTPUT FORMAT (JSON):
{
  "status": "APPROVED" | "REJECTED" | "MODIFIED",
  "reason": "Brief explanation",
  "correction": {"action": "...", "args": {...}} // Only if status is MODIFIED or REJECTED
}
**CRITICAL**: You MUST use the key "status". Do NOT use "answer", "decision", "verdict", or "evaluation". I will not understand them.
If you mean "no", "incorrect", or "bad", you MUST set "status": "REJECTED".
`;


// 🚔 SPOTLIGHT VALIDATOR - Enforces Spotlight → Space → Type Law
const SPOTLIGHT_VALIDATOR_PROMPT = `You are a Spotlight Sequence Validator. Your ONLY job is to enforce THE LAW:

🚨 THE LAW: Spotlight opened → NEXT action MUST be Space → THEN Type

INPUT: 
- Previous action (e.g., used spotlight_search tool)
- Proposed next action (what AI wants to do now)

YOUR JOB:
1. If previous action = Spotlight search:
   - Check if proposed action = Space press
   - If YES → Return {"status": "APPROVED"}
   - If NO (e.g., trying to Type) → Return {"status": "REJECTED", "reason": "SPOTLIGHT LAW BROKEN! You opened Spotlight but did NOT press Space. You must press Space BEFORE typing. Sequence: Spotlight → Space → Type"}

2. If previous action = Space was pressed:
   - Check if proposed action = Type
   - If YES → Return {"status": "APPROVED"}
   - If NO → Return {"status": "REJECTED", "reason": "After pressing Space, you must Type next. Do not skip to other actions."}

3. Otherwise → Return {"status": "APPROVED"}

RESPOND ONLY WITH JSON. NEVER SKIP THIS CHECK FOR SPOTLIGHT.
`;

// 🕵️ VERIFIER FUNCTION
async function verifyAction(userGoal, screenshot, proposedAction) {
    try {
        const response = await retryWithBackoff(async () => {
            return await getAi().models.generateContent({
                model: CONFIG.MODEL_NAME,
                systemInstruction: VERIFIER_PROMPT,
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    mimeType: "image/png",
                                    data: screenshot
                                }
                            },
                            {
                                text: `USER GOAL: ${userGoal}                            
PROPOSED ACTION: ${JSON.stringify(proposedAction)}

Verify this action. Return JSON.`
                            }
                        ]
                    }
                ]
            });
        });

        const text = response.candidates[0].content.parts[0].text;
        console.log("🕵️ Verifier says:", text);
        let result = extractJSON(text);

        // [NEW] SMART NORMALIZATION
        // Fixes: Model returning {"answer": "no"} instead of {"status": "REJECTED"}
        if (result) {
            // 1. Map alternative keys to 'status'
            if (!result.status) {
                if (result.answer) result.status = result.answer;
                if (result.decision) result.status = result.decision;
                if (result.verdict) result.status = result.verdict;
                if (result.evaluation) result.status = result.evaluation;
            }

            // 2. Map negative values to "REJECTED"
            if (result.status) {
                const s = String(result.status).toLowerCase();
                if (s.includes("no") || s.includes("reject") || s.includes("false") || s.includes("bad") || s.includes("incorrect")) {
                    result.status = "REJECTED";
                } else if (s.includes("yes") || s.includes("approve") || s.includes("true") || s.includes("good") || s.includes("correct") || s.includes("pass") || s.includes("accept")) {
                    result.status = "APPROVED";
                }
            } else {
                // 3. Last Resort: Scan 'explanation' or 'reason' for negative words
                const reason = (result.reason || result.explanation || "").toLowerCase();
                if (reason.includes("wrong") || reason.includes("incorrect") || reason.includes("reject")) {
                    result.status = "REJECTED";
                }
            }
        }

        return result;

    } catch (error) {
        console.error("⚠️ Verification system unavailable:", error.message);
        console.error("   Proceeding with caution. Actual user action may differ from expectations.");
        return { status: "APPROVED", reason: "Verifier unavailable, failing open." };
    }
}

// 🧠 PLANNER - Analyzes screenshot and returns action plan
async function planNextAction(userGoal, screenshot, context = "", screenSize = { width: 1920, height: 1080 }) {
    try {
        // ✅ Shell-first gate for common file/folder operations
        const inferredShell = inferShellCommand(userGoal);
        if (inferredShell) {
            console.log("🧩 Shell gate triggered. Using inferred command:", inferredShell);
            return { action: "shell", args: { command: inferredShell } };
        }

        // 🔁 Terminal Spotlight loop breaker
        if (isRepeatedTerminalSpotlight(actionHistory)) {
            const shortcut = await getShortcutCached("Terminal", "new window");
            if (shortcut && shortcut !== "null") {
                console.log("🛑 Terminal loop detected. Using shortcut for new window:", shortcut);
                return { action: "key_combo", args: { keys: shortcut } };
            }
        }

        // [NEW] ⚡️ HARD LOOP DETECTION (Force Tab Fallback)
        // User Logic: If we are interacting with the same screen area repeatedly, FORCE TAB.
        // Fixes: "Move -> Click -> Move -> Click" loops where 'consecutiveMoves' fails.
        if (actionHistory.length >= 3) {
            let recentActions = actionHistory.slice(-5); // Look at last 5
            let sameSpotCount = 0;

            // Get the last known coordinates
            let lastCoords = null;
            for (let i = recentActions.length - 1; i >= 0; i--) {
                if (recentActions[i].args && recentActions[i].args.x !== undefined) {
                    lastCoords = recentActions[i].args;
                    break;
                }
            }

            // Count how many recent actions were near this spot
            if (lastCoords) {
                for (let act of recentActions) {
                    if (act.args && act.args.x !== undefined) {
                        const distanceInPixels = Math.sqrt(Math.pow(act.args.x - lastCoords.x, 2) + Math.pow(act.args.y - lastCoords.y, 2));
                        if (distanceInPixels < CONFIG.LOOP_DETECTION_RADIUS_PX) sameSpotCount++;
                    }
                }
            }

            // [USER REQUEST]: REMOVED HARD TAB FALLBACK
            // The user wants natural intelligence (shortcuts first), not hard triggers.
            /*
            if (sameSpotCount >= 3) {
                console.log(`🔄 HARD LOOP DETECTED (${sameSpotCount} actions in same spot). Forcing TAB fallback.`);
                return { action: "key", args: { key: "tab" } };
            }
            */
        }

        // [NEW] 🧠 Retrieve relevant memories (CONTEXTUAL LEARNING)
        let memoryContext = "";
        try {
            // Search for relevant past interactions (cached to reduce API load).
            global.memorySearchState = global.memorySearchState || {};
            const cached = global.memorySearchState[userGoal];
            const now = Date.now();
            let relevantMemories = [];
            if (cached && (now - cached.ts) < (CONFIG.MEMORY_SEARCH_CACHE_TTL_MS || 15000)) {
                relevantMemories = cached.results || [];
            } else {
                relevantMemories = await memory.search(userGoal, 8); // pull wider set, then filter to task-relevant
                global.memorySearchState[userGoal] = { ts: now, results: relevantMemories };
            }
            const taskMemories = relevantMemories.filter((m) => {
                const meta = m?.metadata || {};
                if (meta.type === "chat") return false;
                if (meta.action === "chat") return false;
                if (typeof m?.text === "string" && m.text.startsWith("ACTION: chat |")) return false;
                return true;
            }).slice(0, 5);

            if (taskMemories.length > 0) {
                memoryContext = `
🧠 LEARNED COORDINATES & PAST MISTAKES (MEM0):
${taskMemories.map(m => `   - ${m.text}`).join('\n')}
   - USE THIS HISTORY: If a coordinate failed before (RESULT: REJECTED), DO NOT USE IT AGAIN.
   - If a coordinate worked (RESULT: SUCCESS), USE IT.
`;
                console.log("🧠 Injected Contextual Memories:", taskMemories.map(m => m.text));
            }
        } catch (memErr) {
            console.error("⚠️ Memory retrieval failed:", memErr.message);
        }

        // [MODIFIED] Append protocol violation context if encountered
        let enhancedContext = context + memoryContext;

        // Inject shortcut context based on current app (autonomous)
        let shortcutContext = "";
        try {
            const shortcutInfo = await getShortcutContextForScreen(userGoal, screenshot);
            if (shortcutInfo) {
                shortcutContext = `
CURRENT APP: ${shortcutInfo.app}
APP SHORTCUTS:
${(shortcutInfo.shortcuts || []).map(s => `- ${s.action}: ${s.shortcut}`).join("\n")}
RELEVANT SHORTCUTS FOR GOAL:
${(shortcutInfo.relevant || []).map(s => `- ${s.action}: ${s.shortcut}`).join("\n")}
MACOS SHORTCUTS:
${(shortcutInfo.macos || []).map(s => `- ${s.action}: ${s.shortcut}`).join("\n")}
`;
            }
        } catch {}
        enhancedContext += shortcutContext;
        // Mouse actions are disabled; do not include mouse-protocol warnings that can confuse the planner.
        if (isFileOperationGoal(userGoal)) {
            enhancedContext += "\n\nFILE OPERATION DETECTED: You MUST use shell tools (open_app/mdfind/open_url/shell). Do NOT use Spotlight.";
        }
        if (global.terminalIsOpen) {
            enhancedContext += "\n\nTERMINAL IS ALREADY OPEN: Do NOT open it again. Use shell or shortcut for new window/tab (discover via find_shortcuts).";
        }
        if (global.chromeJsDisabled) {
            enhancedContext += "\n\nCHROME JS AUTOMATION DISABLED: Do NOT use chrome_eval/instagram_* or chrome_* DOM tools. Stop and ask the user to enable: View -> Developer -> \"Allow JavaScript from Apple Events\" in Google Chrome.";
        }
        const repetition = consecutiveRepetitionInfo(actionHistory);
        if (repetition.count >= 12) {
            enhancedContext += `\n\nLOOP ALERT (critical): Last action pattern "${repetition.fingerprint}" repeated ${repetition.count} times. You must switch strategy now (different tool family, different tab count, or ask user for blocker confirmation).`;
        } else if (repetition.count >= 8) {
            enhancedContext += `\n\nLOOP ALERT: Last action pattern "${repetition.fingerprint}" repeated ${repetition.count} times. Re-check screenshot and choose a materially different action.`;
        } else if (repetition.count >= 5) {
            enhancedContext += `\n\nNudge: Last action pattern "${repetition.fingerprint}" repeated ${repetition.count} times. Consider changing tab count or strategy.`;
        }

        const response = await retryWithBackoff(async () => {
            return await getAi().models.generateContent({
                model: CONFIG.MODEL_NAME,
                systemInstruction: PLANNER_PROMPT,
                contents: [
 
                    {
                        role: "user",
                        parts: [
                            {
                                text: "Example: Create a folder using shell"
                            }
                        ]
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: '{"action": "shell", "args": {"command": "mkdir -p ~/Desktop/MyFolder"}}'
                            }
                        ]
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                text: "Example: Open app using shell"
                            }
                        ]
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: '{"action": "shell", "args": {"command": "open -a \\"Terminal\\""}}'
                            }
                        ]
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                text: "Example: Open app in Chrome if not found"
                            }
                        ]
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: 'Calculator failed to open. Will try Chrome.\n{"action": "key_combo", "args": {"keys": "cmd+b"}}'
                            }
                        ]
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    mimeType: "image/png",
                                    data: screenshot
                                }
                            },
                            {
                                text: `Ignore any terminal windows/command prompts unless they are relevant to the current step. Focus on the active app/page content.

GOAL: ${userGoal}
SCREEN RESOLUTION: ${screenSize.width}x${screenSize.height}
ESTIMATED SCREEN CENTER: X=${Math.floor(screenSize.width / 2)}, Y=${Math.floor(screenSize.height / 2)}

CONTEXT FROM PREVIOUS ATTEMPTS:
${enhancedContext}

Runtime constraints:
- Use shell-first for deterministic operations.
- For Chrome web apps (Instagram/YouTube/etc), prefer DOM-first tools (chrome_* / instagram_*). Avoid Tab navigation.
- move/click tools are disabled.
- Ask user only for hard blockers.
- Never repeat the same failed strategy more than twice.

Determine the NEXT SINGLE ACTION needed to achieve this goal. Follow the mandatory verification protocols.`
                            }
                        ]
                    }
                ]
            });
        });

        const text = response.candidates[0].content.parts[0].text;
        console.log("🧠 Planner says:", text);

        // Extract JSON with multiple strategies
        let actionPlan = extractJSON(text);

        // [DISABLED] 🕵️ VERIFICATION DISABLED AS PER USER REQUEST
        // if (actionPlan) {
        //     console.log("🕵️ Verifying plan:", actionPlan);
        //     const verification = await verifyAction(userGoal, screenshot, actionPlan);
        //
        //     if (verification && verification.status === "REJECTED") {
        //         console.log(`❌ VERIFIER REJECTED: ${verification.reason}`);
        //         // ... functionality disabled ...
        //     }
        // }

        if (!actionPlan) {
            console.log("❌ No valid JSON found, using wait");
            actionPlan = { action: "wait", args: { ms: 1000 } };
        }

        // Guard: planner sometimes outputs invalid key_combo like "tab tab tab" (space-separated).
        // Treat these as invalid and switch to DOM context instead of executing nonsense.
        if (
            actionPlan.action === "key_combo" &&
            typeof actionPlan.args?.keys === "string" &&
            /\s/.test(actionPlan.args.keys) &&
            !actionPlan.args.keys.includes("+")
        ) {
            actionPlan = tools.chrome_get_context && !global.chromeJsDisabled
                ? { action: "chrome_get_context", args: {} }
                : { action: "wait", args: { ms: 800 } };
        }

        // Normalize tab/shift+tab actions to counted variants.
        actionPlan = normalizeKeyboardNavigationAction(actionPlan);

        // Instagram/web policy: do not use Tab navigation. Replace with DOM-first actions.
        if (isInstagramGoal(userGoal) && (isForwardTabAction(actionPlan) || isBackwardTabAction(actionPlan))) {
            const username =
                extractInstagramUsernameFromText(userGoal) ||
                extractInstagramUsernameFromUrl(global.mediaOpenState?.url || "") ||
                null;
            const indexFromLatest = extractPostIndexFromGoal(userGoal);
            actionPlan = (isInstagramPostGoal(userGoal) && tools.instagram_open_post && !global.chromeJsDisabled)
                ? { action: "instagram_open_post", args: { username, index_from_latest: indexFromLatest, include_pinned: false } }
                : (tools.chrome_get_context && !global.chromeJsDisabled) ? { action: "chrome_get_context", args: {} } : { action: "wait", args: { ms: 800 } };
        }

        // Mouse guard: tools are disabled, so convert any stray mouse plan to keyboard/DOM navigation.
        if (actionPlan.action === "move" || actionPlan.action === "click") {
            if (isInstagramPostGoal(userGoal) && tools.instagram_open_post && !global.chromeJsDisabled) {
                const username =
                    extractInstagramUsernameFromText(userGoal) ||
                    extractInstagramUsernameFromUrl(global.mediaOpenState?.url || "") ||
                    null;
                actionPlan = {
                    action: "instagram_open_post",
                    args: {
                        username,
                        index_from_latest: extractPostIndexFromGoal(userGoal),
                        include_pinned: false
                    }
                };
            } else {
                // If the planner tried a forbidden mouse action outside Instagram, re-check context via DOM.
                // This is intentionally non-destructive and avoids tab spam.
                if (tools.chrome_get_context && !global.chromeJsDisabled) {
                    actionPlan = { action: "chrome_get_context", args: {} };
                } else {
                    actionPlan = { action: "wait", args: { ms: 800 } };
                }
            }
        }

        // Instagram loop breaker:
        // prefer DOM navigation when tab/page navigation repeats without visible progress.
        if (isInstagramPostGoal(userGoal)) {
            const tabLoopCount = recentTabNavigationActionCount(actionHistory);
            const domActionCount = recentInstagramDomActionCount(actionHistory);
            const recent = actionHistory.slice(-12);
            const username =
                extractInstagramUsernameFromText(userGoal) ||
                extractInstagramUsernameFromUrl(global.mediaOpenState?.url || "") ||
                null;
            const indexFromLatest = extractPostIndexFromGoal(userGoal);

            if (isPageScrollAction(actionPlan) && tools.instagram_open_post && !global.chromeJsDisabled) {
                actionPlan = {
                    action: "instagram_open_post",
                    args: { username, index_from_latest: indexFromLatest, include_pinned: false }
                };
            }

            // Comment-entry helper:
            // After latest navigation, "c" may fail unless focus is advanced first.
            // Use dedicated tool before blind tab/c loops.
            if (isInstagramCommentGoal(userGoal) && tools.instagram_focus_comment && !global.chromeJsDisabled) {
                const commentHotkeyAttempts = recent.filter((a) => isCommentShortcutAction(a)).length;
                const focusToolAttempts = recent.filter((a) => a.action === "instagram_focus_comment").length;
                const plannerRequestedCommentHotkey = isCommentShortcutAction(actionPlan);
                const plannerRequestedSmallTab =
                    isForwardTabAction(actionPlan) && getRepeatCount(actionPlan.args, 1) <= 3;

                if ((plannerRequestedCommentHotkey || plannerRequestedSmallTab || commentHotkeyAttempts >= 2) && focusToolAttempts < 3) {
                    actionPlan = { action: "instagram_focus_comment", args: {} };
                }
            }
        }

        // Post-processing: prevent reopening Terminal if already open
        if (
            global.terminalIsOpen &&
            actionPlan.action === "spotlight_search" &&
            actionPlan.args?.query?.toLowerCase().includes("terminal")
        ) {
            const shortcut = await getShortcutCached("Terminal", "new window");
            if (shortcut && shortcut !== "null") {
                console.log("🛑 Terminal already open. Switching to shortcut:", shortcut);
                actionPlan = { action: "key_combo", args: { keys: shortcut } };
            }
        }

        console.log("🎯 Action plan:", actionPlan);
        return actionPlan;

    } catch (error) {
        console.error("❌ Planner error:", error.message);
        return { action: "wait", args: { ms: 1000 } };
    }
}

// 🎹 Helper: Check if key combination is a Spotlight trigger

function getOrInitRunState(runId, initialGoal) {
    const id = String(runId || "default");
    global.runStates = global.runStates || Object.create(null);
    let state = global.runStates[id];
    if (!state) {
        state = {
            id,
            startedAt: Date.now(),
            goalRaw: String(initialGoal || ""),
            completed: Object.create(null), // key -> { ts, detail }
            cache: Object.create(null)
        };
        global.runStates[id] = state;
    }

    // Always keep the latest supplied goal for this run id.
    // The caller may append multiple "User input:" turns while continuing the same run.
    const g = String(initialGoal || "");
    if (g && g !== String(state.goalRaw || "")) {
        state.goalRaw = g;
    }

    // Best-effort cleanup to avoid unbounded growth.
    try {
        const keys = Object.keys(global.runStates);
        if (keys.length > 40) {
            keys
                .map((k) => ({ k, ts: global.runStates[k]?.startedAt || 0 }))
                .sort((a, b) => a.ts - b.ts)
                .slice(0, keys.length - 30)
                .forEach(({ k }) => delete global.runStates[k]);
        }
    } catch {}

    return state;
}

function markCompletedStep(runState, key, detail = "") {
    if (!runState) return;
    runState.completed = runState.completed || Object.create(null);
    if (runState.completed[key]) return;
    runState.completed[key] = { ts: Date.now(), detail: String(detail || "").slice(0, 200) };
}

function buildRunContext(runState) {
    const completed = runState?.completed || {};
    const keys = Object.keys(completed);
    if (keys.length === 0) return "";
    const lines = keys
        .sort((a, b) => (completed[a]?.ts || 0) - (completed[b]?.ts || 0))
        .map((k) => {
            const d = completed[k]?.detail ? ` (${completed[k].detail})` : "";
            return `- ${k}${d}`;
        })
        .join("\n");
    return `COMPLETED_STEPS (do not repeat these):\n${lines}\n\nRule: Any step listed above is already done successfully. Continue with remaining steps only.`;
}

function wantsRepeatOf(goal = "", verb = "") {
    const g = String(goal || "").toLowerCase();
    const v = String(verb || "").toLowerCase();
    if (!v) return false;
    if (g.includes(`${v} again`)) return true;
    if (g.includes(`${v} twice`)) return true;
    if (g.match(new RegExp(`\\b(2|two|multiple)\\b[^\\n]{0,30}\\b${v}\\b`, "i"))) return true;
    return false;
}

// 🚀 MAIN AGENT FUNCTION - Called by Electron or CLI
async function runAgent(goal, options = {}) {
    const { signal } = options;
    const runId = options.runId || "default";
    const runState = getOrInitRunState(runId, goal);

    try {
        // Allow external callers (/stop) to cancel quickly by making tools abort-aware.
        // tools.mjs reads this before executing side-effectful actions.
        global.currentAbortSignal = signal || null;
        if (signal?.aborted) {
            return { stop: true, error: "Aborted by user (/stop)" };
        }

        // Use the latest internal goal for this run (captures injected comment drafts, extracted text, etc).
        goal = String(runState.goalRaw || goal || "");
        // Apply any explicit user follow-up choice ("User input: latest", etc) without hardcoding task-specific behavior.
        goal = normalizeGoalFromUserInput(goal);
        runState.goalRaw = goal;

        // If the YouTube lookup target changed in this run, reset sticky URL/comment state
        // so we can navigate to the new target instead of staying locked on the previous one.
        try {
            const lookupGoal = getYouTubeLookupGoal(goal);
            if (lookupGoal && isYouTubeIntentText(lookupGoal)) {
                const lookupKey = stripCommentInstructionsForLookup(lookupGoal).toLowerCase();
                const prevLookupKey = String(runState.cache?.youtube_last_lookup_key || "").toLowerCase();
                if (lookupKey && lookupKey !== prevLookupKey) {
                    runState.cache = runState.cache || Object.create(null);
                    runState.cache.youtube_last_lookup_key = lookupKey;
                    delete runState.cache.youtube_locked_url;
                    delete runState.cache.youtube_candidates_tried;
                    delete runState.cache.youtube_last_playable;
                    if (runState.completed) delete runState.completed.youtube_comment_posted;

                    if (global.mediaOpenState?.runId === runId) {
                        global.mediaOpenState.opened = false;
                        global.mediaOpenState.url = null;
                    }
                }
            }
        } catch {}

        // If we previously expanded a shell->osascript macro, drain it deterministically.
        // Execute queued actions directly (skip planner) to avoid re-planning loops.
        if (Array.isArray(global.actionQueue) && global.actionQueue.length > 0) {
            if (signal?.aborted) return { stop: true, error: "Aborted by user (/stop)" };
            const queued = global.actionQueue.shift();
            if (!queued || !queued.action || !tools[queued.action]) {
                global.actionQueue = [];
            } else {
                console.log(`🦾 Executing (queued): ${queued.action}(${JSON.stringify(queued.args)})`);
                const result = await tools[queued.action](queued.args || {});
                console.log(`✅ Tool result (queued): ${result}`);
                actionHistory.push({ action: queued.action, args: queued.args, timestamp: Date.now() });
                if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();
                return { stop: false, result };
            }
        }

        // Global cooldown to avoid hammering Gemini when we are rate-limited/quota-limited.
        if (global.geminiCooldownUntil && Date.now() < global.geminiCooldownUntil) {
            const waitMs = Math.max(500, Math.min(120000, global.geminiCooldownUntil - Date.now()));
            return { stop: false, result: `rate_limited_wait:${waitMs}` };
        }

        const clarification = needsClarification(goal);
        if (clarification) {
            return { stop: true, ask_user: true, question: clarification };
        }

        const docHandled = await handleDocumentExtraction(goal);
        if (docHandled.asked) {
            return { stop: true, ask_user: true, question: docHandled.question };
        }
        if (docHandled.goal !== goal) {
            goal = docHandled.goal;
            runState.goalRaw = goal;
        }

        // Comment drafting context so the planner does not ask the user for wording.
        const needsCommentDraft = (isInstagramCommentGoal(goal) || isYouTubeCommentGoal(goal)) && !/SUGGESTED_COMMENT:/i.test(goal);
        if (needsCommentDraft) {
            const cachedDraft = runState.cache?.suggestedCommentDraft;
            const draft = cachedDraft || (await buildSuggestedComment(goal));
            if (draft?.comment) {
                runState.cache = runState.cache || Object.create(null);
                runState.cache.suggestedCommentDraft = draft;
                goal = `${goal}\n\nSUGGESTED_COMMENT: ${draft.comment}\nTOPIC_HINT: ${draft.topicHint || "public post context"}`;

                // If a quote already exists in cache, carry it forward.
                // Do not try transcript extraction yet; that should happen after a specific YouTube watch page is open.
                if (isYouTubeCommentGoal(goal) && wantsQuoteFromVideo(goal) && !/SUGGESTED_QUOTE:/i.test(goal)) {
                    const cachedQuote = runState.cache?.suggestedQuote;
                    if (cachedQuote) goal = `${goal}\nSUGGESTED_QUOTE: ${cachedQuote}`;
                }
                runState.goalRaw = goal;
            }
        }

        // Run helper-thinking early so decisions are visible even when media resolution exits before planner.
        const preRunContext = buildRunContext(runState);
        const helperPrefetch = await getHelperThinkingContext(goal, preRunContext, runState, { stage: "pre_resolver" });
        if (helperPrefetch?.mustAskUser && helperPrefetch?.question && !shouldResolveMediaUrl(goal)) {
            return { stop: true, ask_user: true, question: helperPrefetch.question };
        }

        // DOM-first requires Chrome Apple Events JS. If it is disabled, we can't reliably automate web apps
        // without falling back to tab spam. Treat this as a hard blocker and ask once.
        if (global.chromeJsDisabled === true && (isInstagramGoal(goal) || inferMediaPlatform(goal) === "youtube" || /browser|chrome|website|web\s+app/i.test(goal))) {
            if (!global.chromeJsEnablePrompted) {
                global.chromeJsEnablePrompted = true;
                return {
                    stop: true,
                    ask_user: true,
                    question:
                        'Chrome DOM automation is blocked. In Google Chrome, enable: View -> Developer -> "Allow JavaScript from Apple Events". Then retry the task.'
                };
            }
        }

        // URL-first resolver for YouTube/Instagram content lookup tasks.
        global.mediaOpenState = global.mediaOpenState || {};
        // Key state to the runId (not the raw goal string) so injected metadata (SUGGESTED_COMMENT, COMPLETED_STEPS, etc.)
        // does not reset media navigation and cause reopen/re-comment loops.
        if (global.mediaOpenState.runId !== runId) {
            global.mediaOpenState = { runId, goal, opened: false, attempts: 0, url: null };
        }
        if (shouldResolveMediaUrl(goal) && !global.mediaOpenState.opened && (global.mediaOpenState.attempts || 0) < 3) {
            global.mediaOpenState.attempts = (global.mediaOpenState.attempts || 0) + 1;
            if (signal?.aborted) return { stop: true, error: "Aborted by user (/stop)" };

            // For Instagram: if a username is present, skip Gemini resolution and open the profile directly.
            const normalizedYouTubeGoal = getYouTubeLookupGoal(goal);
            const inferredPlatform = inferMediaPlatform(goal);
            const resolutionGoal = inferredPlatform === "youtube" ? normalizedYouTubeGoal : goal;
            if (inferredPlatform === "youtube") {
                console.log(`🔎 YouTube lookup goal: ${resolutionGoal}`);
            }
            const fallbackUser = inferredPlatform === "instagram" ? extractInstagramUsernameFromText(resolutionGoal) : null;
            let resolved = null;
            const directUrl = extractDirectMediaUrlFromGoal(resolutionGoal, inferredPlatform);
            if (directUrl) {
                resolved = { platform: inferredPlatform, title: "", url: directUrl };
                if (inferredPlatform === "youtube") {
                    runState.cache = runState.cache || Object.create(null);
                    runState.cache.youtube_locked_url = directUrl;
                }
            } else {
                // YouTube: prefer deterministic DOM-first channel navigation over LLM-proposed watch URLs.
                if (inferredPlatform === "youtube" && !global.chromeJsDisabled && !/\buser input:\s*search reupload\b/i.test(String(goal || ""))) {
                    const yt = await resolveYouTubeViaChannelDom(resolutionGoal, runState);
                    if (yt?.unavailable) {
                        return {
                            stop: true,
                            ask_user: true,
                            question:
                                `That YouTube target appears unavailable/private (${yt.reason || "unavailable"}).\n` +
                                `Reply with one option:\n` +
                                `0) "search reupload"\n` +
                                `1) "latest" (different/latest public match)\n` +
                                `2) a specific YouTube URL\n` +
                                `3) a more exact video title`
                        };
                    }
                    if (yt?.ok === true && yt.url) {
                        resolved = { platform: "youtube", title: yt.title || "", url: yt.url, _already_opened: true };
                        // resolveYouTubeViaChannelDom already navigated; mark opened to prevent immediate reopen loops.
                        global.mediaOpenState.opened = true;
                        global.mediaOpenState.url = yt.url;
                    } else if (yt?.needs_search && tools.youtube_search && tools.youtube_get_video_meta) {
                        // If no recent upload matches keywords, fall back to a DOM-extracted YouTube search (no Gemini URLs).
                        const channelHint = extractYouTubeChannelHint(resolutionGoal).trim();
                        const keywords = extractTopicKeywords(resolutionGoal, channelHint);
                        const qParts = [];
                        if (channelHint) qParts.push(channelHint);
                        if (keywords.length) qParts.push(...keywords);
                        if (!keywords.length && wantsVlog(resolutionGoal)) qParts.push("vlog");
                        if (wantsEarliest(resolutionGoal)) qParts.push("first");
                        if (wantsMostViewed(resolutionGoal)) qParts.push("most viewed");
                        const query = qParts.join(" ").trim();
                        if (query) {
                            const searchRaw = await tools.youtube_search({ query, max_results: 10 });
                            const search = extractJSON(String(searchRaw)) || null;
                            const results = Array.isArray(search?.results) ? search.results : [];
                            const candidates = results
                                .map(r => ({ title: r.title, url: r.url, channel: r.channel }))
                                .filter(r => isValidPlatformUrl("youtube", String(r?.url || "")));
                            const picked = await pickWorkingYouTubeUrl(resolutionGoal, candidates, runState);
                            if (picked?.ok === true && picked.url) {
                                resolved = { platform: "youtube", title: picked.title || "", url: picked.url, _already_opened: true };
                                global.mediaOpenState.opened = true;
                                global.mediaOpenState.url = picked.url;
                            } else if (picked?.question) {
                                return { stop: true, ask_user: true, question: picked.question };
                            }
                        }
                    }
                }
                resolved = resolved || ((!fallbackUser && inferredPlatform) ? await resolveMediaTarget(resolutionGoal) : null);
            }
            if (resolved?.rate_limited) {
                const waitMs = Math.max(500, Math.min(120000, resolved.retry_after_ms || 35000));
                return { stop: false, result: `rate_limited_wait:${waitMs}` };
            }
            let openUrl = resolved?.url || null;
            let urlAlreadyOpened = Boolean(resolved && resolved._already_opened === true);
            // YouTube resolver now returns candidates; validate/open a working one before proceeding.
            if (inferredPlatform === "youtube" && resolved && !directUrl) {
                const candidates = Array.isArray(resolved.candidates) ? resolved.candidates : [];
                if (candidates.length > 0 && tools.youtube_get_video_meta && !global.chromeJsDisabled) {
                    const picked = await pickWorkingYouTubeUrl(resolutionGoal, candidates, runState);
                    if (picked?.ok === true && picked.url) {
                        openUrl = picked.url;
                        resolved.url = picked.url;
                        resolved.title = picked.title || resolved.title || "";
                        urlAlreadyOpened = true; // pickWorkingYouTubeUrl opens candidates to validate meta
                        runState.cache = runState.cache || Object.create(null);
                        runState.cache.youtube_locked_url = runState.cache.youtube_locked_url || picked.url;
                    } else if (picked?.question) {
                        // Do not hardcode a special-case pipeline for "first/earliest".
                        // If we can't validate a working URL, ask the user what to do next.
                        return { stop: true, ask_user: true, question: picked.question };
                    }
                }
            }

            if (!openUrl && isInstagramGoal(goal) && fallbackUser) {
                openUrl = `https://www.instagram.com/${fallbackUser}/`;
            }
        if (openUrl) {
            const openResult = urlAlreadyOpened ? "ok" : await openUrlInChromeSameTab(openUrl);
            if (!String(openResult).startsWith("error")) {
                global.mediaOpenState.opened = true;
                global.mediaOpenState.url = openUrl;
                if (!urlAlreadyOpened) {
                    actionHistory.push({ action: "open_url", args: { url: openUrl }, timestamp: Date.now() });
                    if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();
                }

                const isInstagram = (resolved?.platform === "instagram") || isInstagramGoal(goal);
                const isYouTube = (resolved?.platform === "youtube") || inferMediaPlatform(goal) === "youtube";

                // YouTube DOM-first: if user intent is to comment, do it deterministically after opening the resolved URL.
                if (isYouTube && isYouTubeCommentGoal(goal) && /SUGGESTED_COMMENT:/i.test(goal) && !global.chromeJsDisabled) {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                    try {
                        if (tools.chrome_wait) {
                            await tools.chrome_wait({
                                predicate_js: "document.readyState === 'complete' || document.readyState === 'interactive'",
                                timeout_ms: 10000,
                                interval_ms: 250
                            });
                        }
                    } catch {}

                    // Detect private/unavailable videos and never claim success in that case.
                    if (tools.youtube_get_status) {
                        const statusRaw = await tools.youtube_get_status({});
                        const status = extractJSON(String(statusRaw)) || null;
                        if (isHardUnavailableStatus(status)) {
                            // Try one alternative resolution: must be playable/public.
                            runState.cache = runState.cache || Object.create(null);
                            const tried = runState.cache.youtube_alt_resolve_attempts || 0;
                            if (tried < 1) {
                                runState.cache.youtube_alt_resolve_attempts = tried + 1;
                                const alt = await resolveMediaTarget(`${goal}\n\nConstraint: choose a currently playable public YouTube video (avoid private/unavailable/removed). If the target is private, pick the closest public alternative.`);
                                if (alt?.url && alt.url !== openUrl) {
                                    const altCmd = `open -a "Google Chrome" "${alt.url}"`;
                                    await tools.shell({ command: altCmd });
                                    await new Promise(resolve => setTimeout(resolve, 1200));
                                    const altStatusRaw = await tools.youtube_get_status({});
                                    const altStatus = extractJSON(String(altStatusRaw)) || null;
                                    if (isHardUnavailableStatus(altStatus)) {
                                        return {
                                            stop: true,
                                            ask_user: true,
                                            question: `That YouTube video is unavailable/private (${altStatus.reason || status.reason || "unavailable"}). Reply with a different video name or a different channel/video URL.`
                                        };
                                    }
                                } else {
                                    return {
                                        stop: true,
                                        ask_user: true,
                                        question: `That YouTube video is unavailable/private (${status.reason || "unavailable"}). Reply with a different video name or a different channel/video URL.`
                                    };
                                }
                            } else {
                                return {
                                    stop: true,
                                    ask_user: true,
                                    question: `That YouTube video is unavailable/private (${status.reason || "unavailable"}). Reply with a different video name or a different channel/video URL.`
                                };
                            }
                        }
                    }

                    const quotePrep = await ensureYouTubeQuoteIfRequested(goal, runState);
                    goal = quotePrep.goal;
                    if (quotePrep.askUser && quotePrep.question) {
                        return { stop: true, ask_user: true, question: quotePrep.question };
                    }

                    // Submit comment (and confirm conservatively).
                    const m = String(goal).match(/SUGGESTED_COMMENT:\s*(.+)/i);
                    const commentBase = (m ? m[1] : "").trim();
                    if (commentBase && tools.youtube_post_comment) {
                        const alreadyCommented = Boolean(runState.completed?.youtube_comment_posted);
                        if (!alreadyCommented || wantsRepeatOf(goal, "comment")) {
                            // Ensure the comment UI exists before trying to post, otherwise we end up in reopen/search loops.
                            // If this times out, treat it as a blocker (usually "not logged in" or comments not loaded).
                            try {
                                if (tools.chrome_wait) {
                                    await tools.chrome_wait({
                                        predicate_js:
                                            "!!document.querySelector('ytd-comment-simplebox-renderer #placeholder-area, #placeholder-area') && " +
                                            "!!document.querySelector('ytd-comments, #comments')",
                                        timeout_ms: 12000,
                                        interval_ms: 250
                                    });
                                }
                            } catch {
                                let ctx = null;
                                try {
                                    if (tools.chrome_get_context && !global.chromeJsDisabled) {
                                        const ctxRaw = await tools.chrome_get_context({});
                                        ctx = extractJSON(String(ctxRaw)) || null;
                                    }
                                } catch {}
                                if (ctx?.loggedOutHint) {
                                    return {
                                        stop: true,
                                        ask_user: true,
                                        question: "YouTube looks logged out. Log in in Chrome, then reply: \"logged in\" and I will retry posting the comment."
                                    };
                                }
                                return {
                                    stop: true,
                                    ask_user: true,
                                    question: "I can't find the YouTube comment box yet (comments not loaded/disabled). If you're logged in, scroll to comments and reply: \"ready\". Or reply with a different video URL."
                                };
                            }

                            const quoteMatch = String(goal).match(/SUGGESTED_QUOTE:\s*(.+)/i);
                            const quote = quoteMatch ? quoteMatch[1].trim() : "";
                            const comment = quote ? `${commentBase}\n"${quote}"` : commentBase;
                            const postRes = await tools.youtube_post_comment({ text: comment });
                            actionHistory.push({ action: "youtube_post_comment", args: { text: comment.slice(0, 120) }, timestamp: Date.now() });
                            if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();

                            if (/^error:\s*youtube_post_comment\s+video_unavailable_or_private/i.test(String(postRes)) || /^error:\s*youtube_video_unavailable_or_private/i.test(String(postRes))) {
                                return {
                                    stop: true,
                                    ask_user: true,
                                    question: "That YouTube video is unavailable/private. Reply with a different video name or a different URL."
                                };
                            }
                            if (/^error:/i.test(String(postRes))) {
                                // Do not keep reopening/researching when the DOM comment action failed.
                                // Surface a concrete blocker so the user can fix (login/consent UI) and we can continue.
                                return {
                                    stop: true,
                                    ask_user: true,
                                    question: `YouTube comment post failed (${String(postRes).replace(/^error:\s*/i, "")}). Reply "retry" after you confirm you're logged in and the comment box is visible.`
                                };
                            }

                            let confirmation = "youtube_comment_unconfirmed";
                            if (tools.youtube_confirm_comment) {
                                confirmation = await tools.youtube_confirm_comment({ text: commentBase, timeout_ms: 6000 });
                            }

                            if (String(confirmation).startsWith("error: youtube_video_unavailable_or_private")) {
                                return {
                                    stop: true,
                                    ask_user: true,
                                    question: "That YouTube video became unavailable/private. Reply with a different video name or a different URL."
                                };
                            }

                            markCompletedStep(runState, "youtube_comment_posted", commentBase.slice(0, 80));
                            // Be explicit if we couldn't confirm DOM feedback to avoid false success claims.
                            if (String(confirmation).includes("unconfirmed")) {
                                return { stop: true, result: "youtube_comment_submitted_unconfirmed" };
                            }

                            // Use validator with a post-action screenshot for completion on multi-step goals.
                            let shot = null;
                            try {
                                const shotRes = await tools.take_screenshot();
                                if (!/failed|error/i.test(String(shotRes))) {
                                    const p = path.join(os.tmpdir(), "agent_screen.png");
                                    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
                                        shot = fs.readFileSync(p).toString("base64");
                                    }
                                }
                            } catch {}

                            const v = await validateTaskCompletion(
                                `${goal}\n\n${buildRunContext(runState)}`,
                                { action: "youtube_comment_submit", args: { comment_preview: commentBase.slice(0, 80) } },
                                String(confirmation),
                                shot
                            );
                            if (v?.needs_user_input && v?.question) return { stop: true, ask_user: true, question: v.question };
                            if (v?.done === true) return { stop: true, result: "comment_posted" };
                            return { stop: false, result: "comment_submitted" };
                        }
                    }
                }

                if (isInstagram && isInstagramPostGoal(goal) && tools.instagram_open_post && !global.chromeJsDisabled) {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                    const username =
                        extractInstagramUsernameFromText(goal) ||
                            extractInstagramUsernameFromUrl(openUrl) ||
                            null;
                        const indexFromLatest = extractPostIndexFromGoal(goal);
                        // Ensure we are on the profile page before opening the post (instagram_open_post no longer navigates).
                        if (username && !String(openUrl).includes(`/p/`) && !String(openUrl).includes(`/reel/`)) {
                            await tools.shell({ command: `open -a "Google Chrome" "https://www.instagram.com/${username}/"` });
                            await new Promise(resolve => setTimeout(resolve, 1200));
                        }

                        // Wait until posts are present before attempting to click one.
                        try {
                            if (tools.chrome_wait && !global.chromeJsDisabled) {
                                await tools.chrome_wait({
                                    predicate_js: "document.querySelectorAll('a[href*=\"/p/\"],a[href*=\"/reel/\"]').length > 0",
                                    timeout_ms: 12000,
                                    interval_ms: 250
                                });
                            }
                        } catch {}

                        const openPostResult = await tools.instagram_open_post({
                            username,
                            index_from_latest: indexFromLatest,
                            include_pinned: false
                        });
                    if (String(openPostResult).startsWith("instagram_post_opened")) {
                        // Give IG a moment to render the post dialog before attempting to comment.
                        // Prefer DOM wait when available to avoid blind sleeps.
                        try {
                            if (tools.chrome_wait && !global.chromeJsDisabled) {
                                await tools.chrome_wait({
                                    predicate_js: "location.pathname.includes('/p/') || location.pathname.includes('/reel/')",
                                    timeout_ms: 8000,
                                    interval_ms: 250
                                });
                            } else {
                                await tools.wait({ ms: 900 });
                            }
                        } catch {}
                        actionHistory.push({
                            action: "instagram_open_post",
                            args: { username, index_from_latest: indexFromLatest },
                            timestamp: Date.now()
                        });
                        if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();
                        // Deterministic Instagram comment pipeline:
                        // 1) Post comment via DOM (preferred), 2) validate completion.
                        // IMPORTANT: Never type blindly unless we have confirmed focus or DOM posted successfully.
                        // If we have a suggested comment, treat this as a comment task (avoid brittle intent parsing).
                        if (isInstagramPostGoal(goal) && /SUGGESTED_COMMENT:/i.test(goal)) {
                            const alreadyCommented = Boolean(runState.completed?.instagram_comment_posted);
                            if (alreadyCommented && !wantsRepeatOf(goal, "comment")) {
                                return { stop: false, result: "instagram_comment_already_completed" };
                            }
                            const m = String(goal).match(/SUGGESTED_COMMENT:\s*(.+)/i);
                            const comment = (m ? m[1] : "").trim();
                            if (comment) {
                                let posted = false;
                                if (tools.instagram_post_comment && !global.chromeJsDisabled) {
                                    const postRes = await tools.instagram_post_comment({ text: comment });
                                    actionHistory.push({ action: "instagram_post_comment", args: { text: comment.slice(0, 120) }, timestamp: Date.now() });
                                    if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();
                                    if (!/^error:/i.test(String(postRes))) posted = true;
                                }

                                if (!posted && tools.instagram_focus_comment && !global.chromeJsDisabled) {
                                    const focusRes = await tools.instagram_focus_comment({});
                                    actionHistory.push({ action: "instagram_focus_comment", args: {}, timestamp: Date.now() });
                                    if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();

                                    // Only proceed if focus is confirmed.
                                    if (String(focusRes).startsWith("comment_focus_ready")) {
                                        await tools.type({ text: comment });
                                        await tools.key({ key: "enter" });
                                        actionHistory.push({ action: "type", args: { text: comment }, timestamp: Date.now() });
                                        actionHistory.push({ action: "key", args: { key: "enter" }, timestamp: Date.now() });
                                        if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.splice(0, actionHistory.length - CONFIG.ACTION_HISTORY_LIMIT);
                                        posted = true;
                                    } else {
                                        // No focus confirmation: do not type. Let planner continue with DOM inspection.
                                        return { stop: false, result: `comment_focus_needed:${focusRes}` };
                                    }
                                }

                                if (posted) {
                                    markCompletedStep(runState, "instagram_comment_posted", comment.slice(0, 80));
                                    if (!/comment_already_posted|comment already posted|comment already submitted/i.test(goal)) {
                                        goal = `${goal}\n\nCOMMENT_ALREADY_POSTED: true`;
                                        runState.goalRaw = goal;
                                    }
                                    // Use the validator to decide completion, using a post-submit screenshot when possible.
                                    let shot = null;
                                    try {
                                        const shotRes = await tools.take_screenshot();
                                        if (!/failed|error/i.test(String(shotRes))) {
                                            const p = path.join(os.tmpdir(), "agent_screen.png");
                                            if (fs.existsSync(p) && fs.statSync(p).size > 0) {
                                                shot = fs.readFileSync(p).toString("base64");
                                            }
                                        }
                                    } catch {}

                                    const v = await validateTaskCompletion(
                                        `${goal}\n\n${buildRunContext(runState)}`,
                                        { action: "instagram_comment_submit", args: { comment_preview: comment.slice(0, 80) } },
                                        "submitted",
                                        shot
                                    );
                                    if (v?.needs_user_input && v?.question) {
                                        return { stop: true, ask_user: true, question: v.question };
                                    }
                                    if (v?.done === true) {
                                        return { stop: true, result: "comment_posted" };
                                    }
                                    return { stop: false, result: "comment_submitted" };
                                }
                            }
                        }

                        return { stop: false, result: `opened_target_post: ${openPostResult}` };
                    }
                }

                const goalLower = String(goal || "").toLowerCase();
                const multiStep =
                    /\b(and|then|after|before|comment|commont|coment|commet|commment|like|follow|unfollow|subscribe|download|upload|save|rename|screenshot|extract|fill|form|write|type)\b/i.test(goalLower);
                if (!multiStep) {
                    return { stop: true, result: `opened_target_url: ${resolved?.title || openUrl}` };
                }
                return { stop: false, result: `opened_target_url: ${resolved?.title || openUrl}` };
            }
        }

            // Prefer retrying URL resolution a few times before falling back to manual browser typing flow.
            if ((global.mediaOpenState.attempts || 0) < 3) {
                return { stop: false, result: "media_resolve_retry" };
            }
        }

        const runContext = buildRunContext(runState);
        const helperContext = await getHelperThinkingContext(goal, runContext, runState, { stage: "planner_gate" });
        if (helperContext?.mustAskUser && helperContext?.question) {
            console.log("❓ Helper model requested clarification:", helperContext.question);
            return { stop: true, ask_user: true, question: helperContext.question };
        }
        const plannerContext = helperContext?.plannerContext
            ? `${runContext}\n\n${helperContext.plannerContext}`
            : runContext;

        // Step 1: Take screenshot
        if (signal?.aborted) return { stop: true, error: "Aborted by user (/stop)" };
        const screenshotResult = await tools.take_screenshot();
        if (/failed|error/i.test(String(screenshotResult))) {
            console.error("❌ Screenshot failed:", screenshotResult);
            return { stop: true, error: `Screenshot failed: ${screenshotResult}` };
        }

        // Step 2: Read screenshot file and encode to base64
        const SCREEN_PATH = path.join(os.tmpdir(), "agent_screen.png");
        if (!fs.existsSync(SCREEN_PATH) || fs.statSync(SCREEN_PATH).size === 0) {
            return { stop: true, error: "Screenshot failed: image file missing or empty" };
        }
        const screenshotBuffer = fs.readFileSync(SCREEN_PATH);
        const screenshotBase64 = screenshotBuffer.toString("base64");

        // Step 3: Plan next action (pass base64 image)
        if (signal?.aborted) return { stop: true, error: "Aborted by user (/stop)" };
        let action = await planNextAction(goal, screenshotBase64, plannerContext);

        if (!action || !action.action) {
            console.error("❌ Invalid action plan");
            return { stop: true, error: "Invalid action plan" };
        }

        // Fast URL shortcut: if planner tries to type a URL, open it directly in Chrome instead.
        // Prevents slow "open chrome -> type url -> enter" loops.
        if (action.action === "type") {
            const typed = String(action.args?.text || "").trim();
            const rawUrlMatch = typed.match(/https?:\/\/[^\s"'<>]+/i);
            let maybeUrl = rawUrlMatch ? String(rawUrlMatch[0]).replace(/[\]")'.,!?]+$/, "") : "";
            if (!maybeUrl) {
                const domainLike = typed.match(/\b(?:www\.)?(youtube\.com|youtu\.be|instagram\.com)\/[^\s"'<>]*/i);
                if (domainLike) {
                    maybeUrl = `https://${String(domainLike[0]).replace(/^https?:\/\//i, "").replace(/[\]")'.,!?]+$/, "")}`;
                }
            }
            if (maybeUrl) {
                action = { action: "shell", args: { command: `open -a "Google Chrome" "${maybeUrl}"` } };
            }
        }

        if (action.action === "shell") {
            const shellCommand = String(action.args?.command || "");
            const repeats = recentSameShellCount(actionHistory, shellCommand);
            if (repeats >= 2) {
                console.log("🛑 Loop guard: repeated shell command detected. Stopping with completion confirmation.");
                return { stop: true, result: `Task likely completed. Repeated shell command prevented: ${shellCommand}` };
            }

            // Force Chrome for web tasks. Our DOM tools only target Google Chrome Apple Events.
            if (/open\s+-a\s+\"arc\"/i.test(shellCommand)) {
                action = { action: "shell", args: { command: shellCommand.replace(/open\s+-a\s+\"arc\"/i, 'open -a "Google Chrome"') } };
            }

            // Instagram DOM-first: prevent reopening the profile page in a loop.
            // If the planner keeps trying to "open https://www.instagram.com/<user>/", do the next logical DOM step instead.
            if (
                isInstagramPostGoal(goal) &&
                tools.instagram_open_post &&
                !global.chromeJsDisabled &&
                /open\s+-a\s+\"google chrome\"/i.test(shellCommand) &&
                /instagram\.com\/[a-z0-9._]+\/?\"?$/i.test(shellCommand)
            ) {
                const m = shellCommand.match(/instagram\.com\/([a-z0-9._]+)/i);
                const username =
                    extractInstagramUsernameFromText(goal) ||
                    extractInstagramUsernameFromUrl(global.mediaOpenState?.url || "") ||
                    (m ? m[1] : null);
                action = { action: "instagram_open_post", args: { username, index_from_latest: extractPostIndexFromGoal(goal), include_pinned: false } };
            }
        }

        // YouTube guard: once we have opened/locked a specific watch page for this run, do NOT let the planner
        // randomly open other watch URLs (this is the main cause of "opened correct video, then switched and claimed failure").
        try {
            const lockedYt = String(runState.cache?.youtube_locked_url || global.mediaOpenState?.url || "").trim();
            // Do not rely on goal text for platform detection once a specific watch URL is locked.
            // Users often omit the word "YouTube" in follow-ups ("latest linux video by pewds"), but we still must not navigate away.
            if (lockedYt && isYouTubeWatchUrl(lockedYt) && !wantsRepeatOf(goal, "open")) {
                let targetUrl = "";
                if (action.action === "shell") {
                    targetUrl = extractFirstHttpUrl(String(action.args?.command || ""));
                } else if (action.action === "chrome_set_url") {
                    targetUrl = String(action.args?.url || "");
                } else if (action.action === "open_url") {
                    targetUrl = String(action.args?.url || "");
                }
                if (targetUrl && isYouTubeWatchUrl(targetUrl) && !isSameYouTubeVideoUrl(targetUrl, lockedYt)) {
                    console.log("🛑 Blocking YouTube navigation away from locked video. Using chrome_get_context instead.");
                    if (tools.chrome_get_context && !global.chromeJsDisabled) {
                        action = { action: "chrome_get_context", args: {} };
                    } else {
                        // Worst case: do nothing instead of navigating away.
                        action = { action: "wait", args: { ms: 800 } };
                    }
                }
            }
        } catch {}

        const repetition = consecutiveRepetitionInfo(actionHistory);
        const nextFingerprint = actionFingerprint(action);
        if (nextFingerprint && repetition.fingerprint === nextFingerprint && repetition.count >= 4) {
            return {
                stop: true,
                ask_user: true,
                question: `I am stuck repeating "${nextFingerprint}". Reply with one hint (for example: target section/app) and I will continue from there.`
            };
        }

        // If planner tried to use shell+osascript for keystrokes, expand into tool actions.
        if (action.action === "shell") {
            const cmd = String(action.args?.command || "");
            const chromeShellAttempt = /osascript/i.test(cmd) && /google chrome/i.test(cmd) && /javascript/i.test(cmd);
            const chromeJs = chromeShellAttempt ? parseShellChromeAppleScriptJs(cmd) : null;
            if (chromeShellAttempt) {
                if (chromeJs && tools.chrome_eval && !global.chromeJsDisabled) {
                    action = { action: "chrome_eval", args: { script: chromeJs } };
                } else if (tools.chrome_get_context && !global.chromeJsDisabled) {
                    action = { action: "chrome_get_context", args: {} };
                } else {
                    return { stop: true, error: "Chrome DOM actions must use chrome_* tools. Shell osascript Chrome automation is blocked in this agent." };
                }
            }
            const steps = parseShellOsascriptKeyMacro(cmd);
            if (steps && steps.length) {
                global.actionQueue = steps.slice(1);
                action = steps[0];
            }
        }

        // Step 4: Execute action
        if (signal?.aborted) return { stop: true, error: "Aborted by user (/stop)" };
        console.log(`🦾 Executing: ${action.action}(${JSON.stringify(action.args)})`);

        // Deterministic YouTube comment pipeline (DOM-first).
        if (isYouTubeCommentGoal(goal) && /SUGGESTED_COMMENT:/i.test(goal)) {
            const alreadyCommented = Boolean(runState.completed?.youtube_comment_posted);
            if (alreadyCommented && !wantsRepeatOf(goal, "comment")) {
                return { stop: false, result: "youtube_comment_already_completed" };
            }
            const quotePrep = await ensureYouTubeQuoteIfRequested(goal, runState);
            goal = quotePrep.goal;
            if (quotePrep.askUser && quotePrep.question) {
                return { stop: true, ask_user: true, question: quotePrep.question };
            }
            const m = String(goal).match(/SUGGESTED_COMMENT:\s*(.+)/i);
            const commentBase = (m ? m[1] : "").trim();
            if (commentBase && tools.youtube_post_comment && !global.chromeJsDisabled) {
                const quoteMatch = String(goal).match(/SUGGESTED_QUOTE:\s*(.+)/i);
                const quote = quoteMatch ? quoteMatch[1].trim() : "";
                const comment = quote ? `${commentBase}\n"${quote}"` : commentBase;
                const postRes = await tools.youtube_post_comment({ text: comment });
                actionHistory.push({ action: "youtube_post_comment", args: { text: comment.slice(0, 120) }, timestamp: Date.now() });
                if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();
                if (/^error:\s*youtube_post_comment\s+video_unavailable_or_private/i.test(String(postRes)) || /^error:\s*youtube_video_unavailable_or_private/i.test(String(postRes))) {
                    return {
                        stop: true,
                        ask_user: true,
                        question: "That YouTube video is unavailable/private. Reply with a different video name or a different URL."
                    };
                }
                if (/^error:/i.test(String(postRes))) {
                    return { stop: false, result: `youtube_comment_failed:${postRes}` };
                }

                let confirmation = "youtube_comment_unconfirmed";
                if (tools.youtube_confirm_comment) {
                    confirmation = await tools.youtube_confirm_comment({ text: commentBase, timeout_ms: 6000 });
                }
                markCompletedStep(runState, "youtube_comment_posted", commentBase.slice(0, 80));
                if (String(confirmation).includes("unconfirmed")) {
                    return { stop: true, result: "youtube_comment_submitted_unconfirmed" };
                }

                const v = await validateTaskCompletion(
                    `${goal}\n\n${buildRunContext(runState)}`,
                    { action: "youtube_comment_submit", args: {} },
                    String(confirmation)
                );
                if (v?.done === true) return { stop: true, result: "comment_posted" };
                return { stop: false, result: "comment_submitted" };
            }
        }

        // If a sub-step is already completed, do not allow the planner to redo it.
        if (runState.completed?.instagram_comment_posted && !wantsRepeatOf(goal, "comment")) {
            if (action.action === "instagram_post_comment" || action.action === "instagram_focus_comment") {
                console.log("🛑 Skipping repeat comment action (already completed). Switching to chrome_get_context.");
                if (tools.chrome_get_context && !global.chromeJsDisabled) {
                    action = { action: "chrome_get_context", args: {} };
                }
            }
        }

        // DOM-first web automation: do not Tab-navigate inside web apps (too unreliable).
        // If the planner tries, replace with a DOM inspection step.
        const platform = inferMediaPlatform(goal);
        const isWebTask =
            platform === "instagram" ||
            platform === "youtube" ||
            /chrome|browser|website|web\s+app|instagram|youtube|twitter|x\.com|reddit/i.test(String(goal || ""));
        if (isWebTask) {
            const isTabKey =
                (action.action === "key" && String(action.args?.key || "").toLowerCase() === "tab") ||
                (action.action === "key_repeat" && String(action.args?.key || "").toLowerCase() === "tab") ||
                (action.action === "key_combo" && String(action.args?.keys || "").toLowerCase().includes("tab")) ||
                (action.action === "key_combo_repeat" && String(action.args?.keys || "").toLowerCase().includes("tab"));
            if (isTabKey && tools.chrome_get_context && !global.chromeJsDisabled) {
                console.log("🛑 Tab navigation blocked for web tasks. Using chrome_get_context instead.");
                action = { action: "chrome_get_context", args: {} };
            }
        }

        // Mouse disabled: enforce at runtime.
        if (action.action === "move" || action.action === "click" || action.action === "scroll") {
            if (tools.chrome_get_context && !global.chromeJsDisabled) {
                action = { action: "chrome_get_context", args: {} };
            } else {
                return { stop: true, error: "Mouse is disabled in this runtime. Planner produced a forbidden mouse action." };
            }
        }

        if (!tools[action.action]) {
            console.error(`❌ Tool not found: ${action.action}`);
            return { stop: false, error: `Tool not found: ${action.action}` };
        }

        const result = await tools[action.action](action.args);
        console.log(`✅ Tool result: ${result}`);

        // Track history for loop detection and terminal state
        actionHistory.push({ action: action.action, args: action.args, timestamp: Date.now() });
        if (actionHistory.length > CONFIG.ACTION_HISTORY_LIMIT) actionHistory.shift();

        // Persist task interaction memory for future task context
        try {
            global.lastTaskMemoryWriteAt = global.lastTaskMemoryWriteAt || 0;
            const now = Date.now();
            if ((now - global.lastTaskMemoryWriteAt) >= (CONFIG.MEMORY_WRITE_MIN_INTERVAL_MS || 4000)) {
                await memory.addInteraction(goal, action, result, "task_step");
                global.lastTaskMemoryWriteAt = now;
            }
        } catch {
            // non-blocking
        }

        if (action.action === "spotlight_search" && action.args?.query?.toLowerCase().includes("terminal")) {
            global.lastSpotlightQuery = "terminal";
        }
        if (action.action === "key_combo" && (action.args?.keys || "").toLowerCase() === "enter" && global.lastSpotlightQuery === "terminal") {
            global.terminalIsOpen = true;
            global.lastSpotlightQuery = null;
        }
        if (action.action === "open_app" && action.args?.app_name?.toLowerCase().includes("terminal")) {
            global.terminalIsOpen = true;
        }
        if (action.action === "shell" && action.args?.command?.toLowerCase().includes("open -a") && action.args?.command?.toLowerCase().includes("terminal")) {
            global.terminalIsOpen = true;
        }

        // Validator decides whether the goal is done or needs user input.
        // Use a post-action screenshot for UI-heavy steps (web/app navigation) to avoid stale validation.
        let validationShot = null;
        try {
            const a = String(action.action || "");
            const uiHeavy =
                a === "type" ||
                a === "key" ||
                a === "key_repeat" ||
                a === "key_combo" ||
                a === "key_combo_repeat" ||
                a.startsWith("instagram_") ||
                a.startsWith("chrome_") ||
                /comment|login|form|fill/i.test(String(goal || ""));
            if (uiHeavy) {
                const shotRes = await tools.take_screenshot();
                if (!/failed|error/i.test(String(shotRes))) {
                    const p = path.join(os.tmpdir(), "agent_screen.png");
                    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
                        validationShot = fs.readFileSync(p).toString("base64");
                    }
                }
            }
        } catch {}

        const validation = await validateTaskCompletion(`${goal}\n\n${buildRunContext(runState)}`, action, result, validationShot);
        if (validation.needs_user_input && validation.question) {
            return { stop: true, ask_user: true, question: validation.question };
        }
        if (validation.done === true) {
            return { stop: true, result: "Task completed" };
        }

        // Persist any goal modifications for the next loop iteration.
        runState.goalRaw = goal;

        return { stop: false, result };

    } catch (error) {
        console.error("❌ Agent error:", error.message);
        return { stop: false, error: error.message };
    }
}

export default runAgent;
