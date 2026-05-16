const toolSchema = {
    functionDeclarations: [
        {
            name: "take_screenshot",
            description: "Capture the current screen and save it as screen.png"
        },
        {
            name: "shell",
            description: "Run a shell command non-interactively (terminal-first).",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Shell command to execute (e.g. 'mkdir -p ~/Desktop/NewFolder')" },
                    cwd: { type: "string", description: "Optional working directory" }
                },
                required: ["command"]
            }
        },
        {
            name: "find_candidate_docs",
            description: "Find candidate documents in common folders by name query.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query for filename" },
                    max_results: { type: "number", description: "Max results to return" },
                    roots: { type: "array", items: { type: "string" }, description: "Optional root folders" }
                },
                required: ["query"]
            }
        },
        {
            name: "extract_text",
            description: "Extract text from a file (PDF/image/text) using local tools.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Path to the file" }
                },
                required: ["file_path"]
            }
        },
        {
            name: "gemini_extract_text",
            description: "Extract text from a file (PDF/image) using Gemini Vision.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Path to the file" }
                },
                required: ["file_path"]
            }
        },
        {
            name: "list_shortcuts",
            description: "List common keyboard shortcuts for an app using Gemini.",
            parameters: {
                type: "object",
                properties: {
                    app_name: { type: "string", description: "Application name" }
                },
                required: ["app_name"]
            }
        },
        {
            name: "get_active_app",
            description: "Get the frontmost macOS app name.",
            parameters: {
                type: "object",
                properties: {}
            }
        },
        {
            name: "type",
            description: "Type text",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string" }
                },
                required: ["text"]
            }
        },
        {
            name: "wait",
            description: "Wait for milliseconds or seconds",
            parameters: {
                type: "object",
                properties: {
                    ms: { type: "number" },
                    seconds: { type: "number" }
                }
            }
        },
        {
            name: "key",
            description: "Press a single key (enter, tab, escape, backspace, space, etc.)",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string" }
                },
                required: ["key"]
            }
        },
        {
            name: "key_combo",
            description: "Press key combinations (cmd+c, ctrl+v, alt+tab, etc.)",
            parameters: {
                type: "object",
                properties: {
                    keys: { type: "string" }
                },
                required: ["keys"]
            }
        },
        {
            name: "key_repeat",
            description: "Press a key multiple times (e.g., tab 20 times).",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string" },
                    count: { type: "number" },
                    times: { type: "number" }
                },
                required: ["key"]
            }
        },
        {
            name: "key_combo_repeat",
            description: "Press a key combo multiple times (e.g., shift+tab 10 times).",
            parameters: {
                type: "object",
                properties: {
                    keys: { type: "string" },
                    count: { type: "number" },
                    times: { type: "number" }
                },
                required: ["keys"]
            }
        },
        {
            name: "enter",
            description: "Press Enter key"
        },
        {
            name: "tab",
            description: "Press Tab key"
        },
        {
            name: "escape",
            description: "Press Escape key"
        },
        {
            name: "backspace",
            description: "Press Backspace key"
        },
        {
            name: "space",
            description: "Press Space key"
        },
        {
            name: "find_shortcuts",
            description: "Finds a Mac keyboard shortcut for a specific action in a specific app.",
            parameters: {
                type: "object",
                properties: {
                    app_name: { type: "string", description: "Name of the application (e.g. Spotify, Chrome)" },
                    intention: { type: "string", description: "What you want to do (e.g. 'Search', 'Shuffle', 'New Tab')" }
                },
                required: ["app_name", "intention"]
            }
        },
        {
            name: "open_app",
            description: "Open a macOS application by name using terminal 'open -a AppName' command",
            parameters: {
                type: "object",
                properties: {
                    app_name: { type: "string", description: "Application name (e.g. Safari, Chrome, Spotify)" }
                },
                required: ["app_name"]
            }
        },
        {
            name: "mdfind",
            description: "Search files/apps using macOS mdfind command (Spotlight index search)",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    type: { type: "string", enum: ["apps", "files"], description: "Search type" }
                },
                required: ["query"]
            }
        },
        {
            name: "open_url",
            description: "Open a URL in default browser using terminal 'open url' command",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL to open (e.g. https://google.com or google.com)" }
                },
                required: ["url"]
            }
        },
        {
            name: "chrome_eval",
            description: "Run JavaScript in the active tab of Google Chrome and return the result.",
            parameters: {
                type: "object",
                properties: {
                    script: { type: "string", description: "JavaScript expression/function to execute in the active tab" }
                },
                required: ["script"]
            }
        },
        {
            name: "chrome_tab_hygiene",
            description: "Keep at most N Chrome tabs open in the front window by closing older tabs.",
            parameters: {
                type: "object",
                properties: {
                    keep: { type: "number", description: "Tabs to keep (default 2, max 3)" }
                }
            }
        },
        {
            name: "chrome_set_url",
            description: "Navigate the active tab of Google Chrome to a URL (reuses the same tab; avoids opening new tabs).",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL to open in the active Chrome tab" }
                },
                required: ["url"]
            }
        },
        {
            name: "chrome_get_dom",
            description: "Return a truncated snapshot of the current page DOM/HTML (debug/planning).",
            parameters: {
                type: "object",
                properties: {
                    max_chars: { type: "number", description: "Max characters of HTML to return (default ~12000)" }
                }
            }
        },
        {
            name: "chrome_get_dom_element",
            description: "Return details for the first DOM element matching a CSS selector (debug/planning).",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector to query" }
                },
                required: ["selector"]
            }
        },
        {
            name: "youtube_get_transcript",
            description: "Extract a transcript snippet from the currently open YouTube video (DOM-first, from captions when available).",
            parameters: {
                type: "object",
                properties: {
                    max_chars: { type: "number", description: "Max characters of transcript to return (default 6000)" }
                }
            }
        },
        {
            name: "youtube_post_comment",
            description: "Post a comment on the currently open YouTube video using DOM-first automation.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Comment text to post" }
                },
                required: ["text"]
            }
        },
        {
            name: "youtube_confirm_comment",
            description: "After submitting a YouTube comment, confirm via toast/DOM that it likely posted (conservative).",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Optional: comment text to look for in DOM" },
                    timeout_ms: { type: "number", description: "Max time to wait for confirmation (ms), default 6000" }
                }
            }
        },
        {
            name: "youtube_get_status",
            description: "Detect whether the current YouTube page is playable or unavailable/private.",
            parameters: {
                type: "object",
                properties: {}
            }
        },
        {
            name: "youtube_get_video_meta",
            description: "Read basic metadata from the current YouTube page (title/channel/description) to validate resolver results.",
            parameters: {
                type: "object",
                properties: {}
            }
        },
        {
            name: "youtube_search",
            description: "Search YouTube (in Chrome) and return a list of video results (title/url/channel) using DOM extraction.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query text" },
                    max_results: { type: "number", description: "Max results to return (default 10, max 20)" }
                },
                required: ["query"]
            }
        },
        {
            name: "chrome_get_context",
            description: "Get basic context from the active Chrome tab (url/title/readyState/active element hints).",
            parameters: { type: "object", properties: {} }
        },
        {
            name: "chrome_list",
            description: "List visible interactable elements in the active Chrome tab by simple filters (DOM-first).",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Optional CSS selector to limit search" },
                    role: { type: "string", description: "Optional exact role filter (e.g., button, link, textbox)" },
                    name: { type: "string", description: "Substring match against aria-label/text/placeholder/href" },
                    text: { type: "string", description: "Substring match against aria-label/text/placeholder/href" },
                    href_contains: { type: "string", description: "Substring match against href" },
                    type: { type: "string", description: "Optional exact type filter for inputs (e.g., submit)" },
                    index: { type: "number", description: "Optional 1-based index (used by click/focus tools; ignored here)" },
                    max_results: { type: "number", description: "Max results to return (default 12, max 50)" }
                }
            }
        },
        {
            name: "chrome_click",
            description: "Click a visible element in the active Chrome tab using DOM filters (no mouse coordinates).",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Optional CSS selector to limit search" },
                    role: { type: "string", description: "Optional exact role filter (e.g., button, link)" },
                    name: { type: "string", description: "Substring match against aria-label/text/href" },
                    text: { type: "string", description: "Substring match against aria-label/text/href" },
                    href_contains: { type: "string", description: "Substring match against href" },
                    type: { type: "string", description: "Optional exact type filter for inputs (e.g., submit)" },
                    index: { type: "number", description: "1-based index to pick among matches (default 1)" },
                    dry_run: { type: "boolean", description: "If true, do not click; just return matches" },
                    max_results: { type: "number", description: "Max matches to consider (default 12, max 50)" }
                }
            }
        },
        {
            name: "chrome_focus",
            description: "Focus a text input/textbox in the active Chrome tab using DOM filters.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Optional CSS selector to limit search" },
                    name: { type: "string", description: "Substring match against aria-label/placeholder/id/class" },
                    text: { type: "string", description: "Alias for name" },
                    index: { type: "number", description: "1-based index to pick among matches (default 1)" }
                }
            }
        },
        {
            name: "chrome_type",
            description: "Type text into the currently focused element in Chrome (DOM set-value or keyboard typing).",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Optional CSS selector to focus before typing." },
                    name: { type: "string", description: "Optional substring to focus (aria-label/placeholder/id/class) before typing." },
                    text: { type: "string", description: "Text to input" },
                    mode: { type: "string", enum: ["dom", "keyboard"], description: "Input method. Default dom." }
                },
                required: ["text"]
            }
        },
        {
            name: "chrome_extract",
            description: "Extract visible text from the current page or a specific selector in Chrome.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Optional CSS selector to extract from" },
                    max_chars: { type: "number", description: "Max chars to return (default 6000)" }
                }
            }
        },
        {
            name: "chrome_wait",
            description: "Wait until a JS predicate becomes true in Chrome (DOM-first synchronization).",
            parameters: {
                type: "object",
                properties: {
                    predicate_js: { type: "string", description: "JavaScript expression that returns true when ready" },
                    timeout_ms: { type: "number", description: "Timeout in ms (default 8000, max 60000)" },
                    interval_ms: { type: "number", description: "Polling interval in ms (default 300)" }
                },
                required: ["predicate_js"]
            }
        },
        {
            name: "instagram_open_post",
            description: "Open an Instagram profile (optional) and open a post by index from latest (prefer non-pinned).",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string", description: "Instagram username without @" },
                    index_from_latest: { type: "number", description: "1=latest, 2=second latest, etc." },
                    include_pinned: { type: "boolean", description: "Include pinned posts in indexing if true" }
                }
            }
        },
        {
            name: "instagram_navigate_post",
            description: "Navigate opened Instagram post carousel left/right by N steps.",
            parameters: {
                type: "object",
                properties: {
                    direction: { type: "string", enum: ["left", "right"] },
                    steps: { type: "number" }
                }
            }
        },
        {
            name: "instagram_focus_comment",
            description: "Focus Instagram comment input using DOM-first logic (no mouse coordinates).",
            parameters: {
                type: "object",
                properties: {}
            }
        },
        {
            name: "instagram_post_comment",
            description: "Post a comment on the currently opened Instagram post using DOM-first logic (set input + click Post).",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Comment text to post" }
                },
                required: ["text"]
            }
        },
        {
            name: "instagram_get_post_caption",
            description: "Read caption text from currently opened Instagram post.",
            parameters: {
                type: "object",
                properties: {}
            }
        },
        {
            name: "google_search",
            description: "Search Google using Gemini's built-in search capability. Returns relevant information directly.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query (e.g. 'how to install Python', 'Netflix movies')" }
                },
                required: ["query"]
            }
        },
        {
            name: "spotlight_search",
            description: "Open Spotlight search (Cmd+Space) and type a query. This uses osascript to simulate the Cmd+Space key combination.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to search for in Spotlight (e.g. 'Safari', 'Instagram', 'Notes')" }
                },
                required: ["query"]
            }
        },
        {
            name: "ask_user",
            description: "Ask the user a question and wait for response. Use when you need user input (password, email, confirmation, etc.)",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "Question to ask the user" },
                    options: { type: "array", description: "Optional: List of options to choose from" }
                },
                required: ["question"]
            }
        }
    ]
};


export default toolSchema;
