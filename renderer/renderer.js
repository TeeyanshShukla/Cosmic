const gate = document.getElementById("api-gate");
// Views and Nav
const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");

// Containers
const chatMessages = document.getElementById("chat-messages");
const taskMessages = document.getElementById("task-messages");

// Inputs
const taskInput = document.getElementById("taskInput");
const chatInput = document.getElementById("chatInput");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const sendChatBtn = document.getElementById("sendChatBtn");

const fileInput = document.getElementById("fileUpload");
const statusLine = document.getElementById("agent-status-line");
const statusText = document.getElementById("status-text");

const apiInput = document.getElementById("apiKeyInput");
const apiError = document.getElementById("error");
const apiBtn = document.getElementById("saveKeyBtn");

const telegramTokenInput = document.getElementById("telegramTokenInput");
const telegramAdminInput = document.getElementById("telegramAdminInput");
const saveTelegramBtn = document.getElementById("saveTelegramBtn");

// [NEW] New Chat Logic
// [NEW] New Chat Logic
const newChatBtn = document.getElementById("newChatBtn");
if (newChatBtn) {
  console.log("✅ New Chat Button found, attaching listener.");
  newChatBtn.addEventListener("click", () => {
    console.log("🧹 New Chat Clicked - Clearing messages.");
    chatMessages.innerHTML = "";
    addMessageTo(chatMessages, "Started a new conversation.", "system");
  });
} else {
  console.error("❌ New Chat Button NOT found in DOM.");
}

console.log("Renderer loaded");

// ============================================
// NAVIGATION LOGIC
// ============================================
navItems.forEach(btn => {
  btn.addEventListener("click", () => {
    navItems.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const targetId = btn.getAttribute("data-target");
    views.forEach(view => {
      if (view.id === targetId) view.classList.add("active");
      else view.classList.remove("active");
    });
  });
});

// ============================================
// STATUS & FEEDBACK SYSTEM
// ============================================
function updateStatus(message, isLoading = false) {
  if (!message) {
    statusLine.classList.add("hidden");
    return;
  }
  statusLine.classList.remove("hidden");
  statusText.textContent = message;
  const spinner = statusLine.querySelector(".spinner");
  spinner.style.display = isLoading ? "inline-block" : "none";
}

// ============================================
// GENERIC MESSAGE HANDLER
// ============================================
function addMessageTo(container, content, type = "assistant") {
  if (!container) return; // Safety

  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${type}`;

  const iconDiv = document.createElement("div");
  iconDiv.className = "message-icon";

  if (type === "user") {
    const photo = localStorage.getItem("userPhoto");
    if (photo) {
      iconDiv.classList.add("user-photo");
      iconDiv.style.backgroundImage = `url(${photo})`;
      iconDiv.innerHTML = "";
    } else {
      // SVG Fallback
      iconDiv.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
    }
  } else {
    iconDiv.textContent = "🤖";
  }

  const bubbleDiv = document.createElement("div");
  bubbleDiv.className = "message-bubble";
  bubbleDiv.textContent = content;

  if (type === "user") {
    messageDiv.appendChild(bubbleDiv);
    messageDiv.appendChild(iconDiv);
  } else {
    messageDiv.appendChild(iconDiv);
    messageDiv.appendChild(bubbleDiv);
  }

  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;
}

// ============================================
// CHAT MODE (Pure Chat)
// ============================================
const chatUploadBtn = document.getElementById("chatUploadBtn");
const chatFileUpload = document.getElementById("chatFileUpload");

chatUploadBtn.onclick = () => chatFileUpload.click();
chatFileUpload.onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    chatInput.value += `\n\n[File Content: ${file.name}]\n${text}\n\n`;
    chatInput.focus();
    updateStatus(`Loaded ${file.name} into chat`, false);
    setTimeout(() => updateStatus(null), 2000);
  };
  reader.readAsText(file);
};

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;

  addMessageTo(chatMessages, text, "user");
  chatInput.value = "";

  try {
    const reply = await window.api.chatOnly(text);
    addMessageTo(chatMessages, reply, "assistant");
  } catch (err) {
    addMessageTo(chatMessages, "Error: " + err.message, "system");
  }
}
sendChatBtn.onclick = sendChat;
chatInput.addEventListener("keypress", (e) => { if (e.key === "Enter") sendChat(); });


// ============================================
// THEME SWITCHING
// ============================================
const swatches = document.querySelectorAll(".theme-swatch");
const root = document.documentElement;

swatches.forEach(swatch => {
  swatch.addEventListener("click", () => {
    swatches.forEach(s => s.classList.remove("active"));
    swatch.classList.add("active");

    const color = swatch.getAttribute("data-color");
    const hover = swatch.getAttribute("data-hover");
    const grad = swatch.getAttribute("data-grad");
    const tint = swatch.getAttribute("data-tint") || "rgba(15, 23, 42, 0.6)";

    root.style.setProperty("--accent-color", color);
    root.style.setProperty("--accent-hover", hover);
    root.style.setProperty("--accent-gradient", grad);
    root.style.setProperty("--bg-primary", tint);
    root.style.setProperty("--bg-sidebar", tint.replace("0.6", "0.4").replace("0.8", "0.6"));

    localStorage.setItem("themeColor", color);
    localStorage.setItem("themeHover", hover);
    localStorage.setItem("themeGrad", grad);
    localStorage.setItem("themeTint", tint);
  });
});

// Load Theme
const savedColor = localStorage.getItem("themeColor");
if (savedColor) {
  root.style.setProperty("--accent-color", savedColor);
  root.style.setProperty("--accent-hover", localStorage.getItem("themeHover"));
  root.style.setProperty("--accent-gradient", localStorage.getItem("themeGrad"));
  const savedTint = localStorage.getItem("themeTint");
  if (savedTint) {
    root.style.setProperty("--bg-primary", savedTint);
    root.style.setProperty("--bg-sidebar", savedTint.replace("0.6", "0.4").replace("0.8", "0.6"));
  }
  swatches.forEach(s => {
    if (s.getAttribute("data-color") === savedColor) s.classList.add("active");
    else s.classList.remove("active");
  });
}

// ============================================
// TASK AGENT MODE
// ============================================

// ============================================
// SETTINGS: TELEGRAM CONFIG
// ============================================
async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    if (settings) {
      if (telegramTokenInput) telegramTokenInput.value = settings.TELEGRAM_BOT_TOKEN || "";
      if (telegramAdminInput) telegramAdminInput.value = settings.TELEGRAM_ADMIN_ID || "";
    }
  } catch (e) {
    console.error("Settings load error:", e.message);
  }
}

if (saveTelegramBtn) {
  saveTelegramBtn.addEventListener("click", async () => {
    const token = telegramTokenInput?.value?.trim() || "";
    const adminId = telegramAdminInput?.value?.trim() || "";
    if (!token || !adminId) {
      alert("Please enter both Telegram token and admin ID.");
      return;
    }
    const ok = await window.api.saveSettings({
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ADMIN_ID: adminId
    });
    alert(ok ? "Telegram settings saved." : "Failed to save Telegram settings.");
  });
}

loadSettings();
// IPC Events
let lastTaskLogTs = 0;
function shouldDisplayTaskLog(message) {
  const m = String(message || "");
  if (!m) return false;
  // Hide noisy dotenv tips by default.
  if (m.includes("[dotenv@")) return false;
  if (m.includes("injecting env")) return false;
  // Show key agent lifecycle + planning/execution events.
  return (
    m.includes("DEBUG:") ||
    m.includes("🧠") ||
    m.includes("🎯") ||
    m.includes("🦾") ||
    m.includes("✅") ||
    m.includes("❌") ||
    m.includes("Validator") ||
    m.includes("Planner says") ||
    m.includes("Tool result") ||
    m.includes("Loop iteration") ||
    m.startsWith("[ERROR]") ||
    m.startsWith("[WARN]")
  );
}
window.api.onLog((message) => {
  if (message.startsWith("STATUS:")) {
    const text = message.replace("STATUS:", "").trim();
    updateStatus(text, true);
  } else {
    const m = String(message || "");
    console.log(`[SYSTEM] ${m}`);
    if (shouldDisplayTaskLog(m)) {
      const now = Date.now();
      // Prevent UI spam when the agent is very chatty.
      if (now - lastTaskLogTs > 80) {
        lastTaskLogTs = now;
        addMessageTo(taskMessages, m, "system");
      }
    }
  }
});

let isRunning = false;
let pendingTaskGoal = null;
let awaitingUserInput = false;

// Stop Handler
stopBtn.onclick = async () => {
  if (!isRunning) return;
  if (window.api.stopAgent) {
    await window.api.stopAgent();
    addMessageTo(taskMessages, "🛑 Stopping task...", "system");
  }
};

runBtn.onclick = async () => {
  const taskText = taskInput.value.trim();
  if (!taskText) return;

  const task = awaitingUserInput && pendingTaskGoal
    ? `${pendingTaskGoal}\nUser input: ${taskText}`
    : taskText;

  addMessageTo(taskMessages, taskText, "user");
  taskInput.value = "";

  isRunning = true;
  runBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  updateStatus("Starting task...", true);

  try {
    const result = await window.api.runTask(task);

    updateStatus(null);
    isRunning = false;
    runBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");

    if (result.success) {
      if (result.result.chat_reply) {
        addMessageTo(taskMessages, result.result.message, "assistant");
      } else if (result.result.ask_user) {
        addMessageTo(taskMessages, `❓ ${result.result.question}`, "assistant");
        addMessageTo(taskMessages, "ℹ️ Please reply to answer.", "system");
        pendingTaskGoal = task;
        awaitingUserInput = true;
      } else {
        addMessageTo(taskMessages, `✅ ${result.result.message || "Done"}`, "assistant");
        pendingTaskGoal = null;
        awaitingUserInput = false;
      }
    } else {
      addMessageTo(taskMessages, `❌ Error: ${result.error}`, "assistant");
      pendingTaskGoal = null;
      awaitingUserInput = false;
    }
  } catch (err) {
    isRunning = false;
    updateStatus(null);
    runBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    addMessageTo(taskMessages, `❌ System Error: ${err.message}`, "assistant");
    pendingTaskGoal = null;
    awaitingUserInput = false;
  }
};

taskInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") runBtn.click();
});

// ============================================
// API GATE & SETTINGS
// ============================================
apiBtn.onclick = async () => {
  const key = apiInput.value.trim();
  if (!key) return;
  apiBtn.innerText = "Verifying...";
  const res = await window.api.saveApiKey(key);
  if (res) {
    document.getElementById("api-gate").style.display = "none";
    addMessageTo(chatMessages, "👋 Ready. How can I assist?", "assistant");
  } else {
    apiError.innerText = "Invalid Key";
    apiBtn.innerText = "Connect";
  }
};

// ============================================
// PROFILE SYSTEM
// ============================================
const profileNameInput = document.getElementById("profileName");
const profileDobInput = document.getElementById("profileDob");
const profilePhotoInput = document.getElementById("profilePhotoInput");
const changePhotoBtn = document.getElementById("changePhotoBtn");
const profilePicPreview = document.getElementById("profile-pic-preview");
const sidebarProfilePic = document.querySelector(".profile-pic-sidebar");
const sidebarName = document.querySelector(".profile-info h3");
const saveProfileBtn = document.getElementById("saveProfileBtn");
const settingsApiKey = document.getElementById("settingsApiKey");
const updateKeyBtn = document.getElementById("updateKeyBtn");

function loadProfile() {
  const name = localStorage.getItem("userName") || "User";
  const dob = localStorage.getItem("userDob") || "";
  const photo = localStorage.getItem("userPhoto");
  profileNameInput.value = name;
  profileDobInput.value = dob;
  sidebarName.textContent = name;
  updateProfilePhotos(photo);
}

function updateProfilePhotos(dataUrl) {
  if (dataUrl) {
    profilePicPreview.style.backgroundImage = `url(${dataUrl})`;
    sidebarProfilePic.style.backgroundImage = `url(${dataUrl})`;
  } else {
    profilePicPreview.style.background = "var(--accent-gradient)";
    sidebarProfilePic.style.background = "var(--accent-gradient)";
  }
}

saveProfileBtn.onclick = () => {
  const name = profileNameInput.value.trim();
  const dob = profileDobInput.value;
  localStorage.setItem("userName", name);
  localStorage.setItem("userDob", dob);
  sidebarName.textContent = name;
  updateStatus("Profile saved.", false);
  setTimeout(() => updateStatus(null), 2000);
};

// ============================================
// PHOTO CROPPER LOGIC
// ============================================
const cropperModal = document.getElementById("cropper-modal");
const cropCanvas = document.getElementById("crop-canvas");
const zoomSlider = document.getElementById("zoom-slider");
const cancelCropBtn = document.getElementById("cancelCropBtn");
const saveCropBtn = document.getElementById("saveCropBtn");
const ctx = cropCanvas.getContext("2d");

let currentImage = null;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

changePhotoBtn.onclick = () => profilePhotoInput.click();

profilePhotoInput.onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      currentImage = img;
      // Reset state
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      zoomSlider.value = 1;

      // Fit image to canvas initially (cover style)
      const ratio = Math.max(cropCanvas.width / img.width, cropCanvas.height / img.height);
      scale = ratio; // Start at 'cover' scale
      zoomSlider.min = ratio * 0.5;
      zoomSlider.max = ratio * 3;
      zoomSlider.value = scale;

      // Center it
      offsetX = (cropCanvas.width - img.width * scale) / 2;
      offsetY = (cropCanvas.height - img.height * scale) / 2;

      cropperModal.classList.remove("hidden");
      drawCropper();
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
};

function drawCropper() {
  if (!currentImage) return;
  // Clear
  ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);

  // Draw Image with transform
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.drawImage(currentImage, 0, 0);
  ctx.restore();
}

// Mouse/Touch Drag Logic
cropCanvas.addEventListener("mousedown", (e) => {
  isDragging = true;
  startX = e.clientX - offsetX;
  startY = e.clientY - offsetY;
});
window.addEventListener("mouseup", () => isDragging = false);
window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  offsetX = e.clientX - startX;
  offsetY = e.clientY - startY;
  drawCropper();
});

// Slider Zoom
zoomSlider.addEventListener("input", (e) => {
  const newScale = parseFloat(e.target.value);
  // Center Zoom? Simplified: just update scale.
  // Ideally we adjust offset to zoom into center, but simple scale is okay for v1
  const prevScale = scale;
  scale = newScale;

  // Adjust offset to keep center
  // math: (center - oldOffset) / oldScale = (center - newOffset) / newScale
  // simpler: let's just let them pan after zoom.
  drawCropper();
});

// Save
saveCropBtn.onclick = () => {
  // Create a temp canvas to extract the circle result?
  // Actually, we can just save the square canvas, css border-radius handles display.
  // But user expects the cropped result.
  const dataUrl = cropCanvas.toDataURL("image/png");
  localStorage.setItem("userPhoto", dataUrl);
  updateProfilePhotos(dataUrl);
  cropperModal.classList.add("hidden");
  updateStatus("Photo updated!", false);
  setTimeout(() => updateStatus(null), 2000);

  // Clear input
  profilePhotoInput.value = "";
};

cancelCropBtn.onclick = () => {
  cropperModal.classList.add("hidden");
  profilePhotoInput.value = "";
};

(async () => {
  const key = await window.api.getApiKey();
  if (key) {
    settingsApiKey.value = key;
    document.getElementById("api-gate").style.display = "none";
  }
  loadProfile();
})();

updateKeyBtn.onclick = async () => {
  const key = settingsApiKey.value.trim();
  if (!key) return;
  const res = await window.api.saveApiKey(key);
  if (res) {
    updateStatus("API Key updated.", false);
    setTimeout(() => updateStatus(null), 2000);
  } else {
    alert("Invalid Key Format");
  }
};
