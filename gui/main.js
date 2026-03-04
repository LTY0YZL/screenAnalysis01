/* global process */
import { spawn } from "child_process";
import crypto from "crypto";
import { Buffer } from "buffer";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from "electron";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.disableHardwareAcceleration();
app.setName("Screen Analysis");

let mainWindow = null;
let overlayWindow = null;
let engineChild = null;
let engineState = "offline";
let enginePort = 41234;
let launchToken = "";
let restartAttempts = 0;
let pendingSnipOptions = null;
let compactModeActive = false;
const DEFAULT_CAPTURE_SHORTCUT = "CommandOrControl+Shift+A";
const maxRestarts = 3;
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const useKeytar = process.env.SCREENANALYSIS_USE_KEYTAR === "1";

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      cloudOptIn: false,
      defaultPromptTemplate: "explain_code",
      dataDir: "",
      models: {
        gemini: "gemini-1.5-flash",
        chatgpt: "gpt-4.1-mini",
        claude: "claude-3-5-sonnet-20241022",
      },
      captureShortcut: DEFAULT_CAPTURE_SHORTCUT,
    };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

function getApiKeyPath() {
  return path.join(app.getPath("userData"), "api_keys.json");
}

function normalizeProvider(provider) {
  const key = String(provider || "").toLowerCase();
  if (key === "openai" || key === "chatgpt") return "chatgpt";
  if (key === "anthropic" || key === "claude") return "claude";
  return "gemini";
}

function readApiKeyStore() {
  try {
    const raw = fs.readFileSync(getApiKeyPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.gemini === "string" || typeof parsed.chatgpt === "string" || typeof parsed.claude === "string") {
      // Migrate old flat schema to new history-aware schema.
      return {
        gemini: { current: parsed.gemini || "", history: parsed.gemini ? [parsed.gemini] : [] },
        chatgpt: { current: parsed.chatgpt || "", history: parsed.chatgpt ? [parsed.chatgpt] : [] },
        claude: { current: parsed.claude || "", history: parsed.claude ? [parsed.claude] : [] },
      };
    }
    return {
      gemini: {
        current: parsed?.gemini?.current || "",
        history: Array.isArray(parsed?.gemini?.history) ? parsed.gemini.history : [],
      },
      chatgpt: {
        current: parsed?.chatgpt?.current || "",
        history: Array.isArray(parsed?.chatgpt?.history) ? parsed.chatgpt.history : [],
      },
      claude: {
        current: parsed?.claude?.current || "",
        history: Array.isArray(parsed?.claude?.history) ? parsed.claude.history : [],
      },
    };
  } catch {
    return {
      gemini: { current: "", history: [] },
      chatgpt: { current: "", history: [] },
      claude: { current: "", history: [] },
    };
  }
}

function writeApiKeyStore(store) {
  fs.writeFileSync(getApiKeyPath(), JSON.stringify(store, null, 2), "utf-8");
}

async function readApiKey(provider) {
  const normalized = normalizeProvider(provider);
  if (useKeytar) {
    try {
      const keytar = await import("keytar");
      const key = await keytar.default.getPassword("screenanalysis", `${normalized}_api_key`);
      if (key) return key;
    } catch {
      // fallback below
    }
  }
  const store = readApiKeyStore();
  if (store[normalized]?.current) return store[normalized].current;
  if (normalized === "chatgpt") return process.env.OPENAI_API_KEY || "";
  if (normalized === "claude") return process.env.ANTHROPIC_API_KEY || "";
  return process.env.GEMINI_API_KEY || "";
}

async function writeApiKey(provider, apiKey) {
  const normalized = normalizeProvider(provider);
  if (useKeytar) {
    try {
      const keytar = await import("keytar");
      await keytar.default.setPassword("screenanalysis", `${normalized}_api_key`, apiKey);
      return;
    } catch {
      // fallback below
    }
  }
  const store = readApiKeyStore();
  const existing = store[normalized] || { current: "", history: [] };
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) {
    store[normalized] = existing;
    writeApiKeyStore(store);
    return;
  }
  const nextHistory = [trimmed, ...existing.history.filter((value) => value !== trimmed)].slice(0, 8);
  store[normalized] = {
    current: trimmed,
    history: nextHistory,
  };
  writeApiKeyStore(store);
}

function maskKey(key) {
  const raw = String(key || "");
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function getSavedKeyOptions(provider) {
  const normalized = normalizeProvider(provider);
  const store = readApiKeyStore();
  const node = store[normalized] || { current: "", history: [] };
  return node.history.map((value) => ({
    id: Buffer.from(value).toString("base64"),
    label: maskKey(value),
    isCurrent: value === node.current,
  }));
}

async function selectSavedKey(provider, keyId) {
  const normalized = normalizeProvider(provider);
  const decoded = Buffer.from(String(keyId || ""), "base64").toString("utf-8");
  const store = readApiKeyStore();
  const node = store[normalized] || { current: "", history: [] };
  if (!node.history.includes(decoded)) {
    throw new Error("Saved API key not found");
  }
  node.current = decoded;
  store[normalized] = node;
  writeApiKeyStore(store);
}

function defaultDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "ScreenAnalysis");
  }
  return path.join(app.getPath("home"), ".screenanalysis");
}

function resolveDataDir() {
  const settings = loadSettings();
  return settings.dataDir && settings.dataDir.trim() ? settings.dataDir : defaultDataDir();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 760,
    title: "Screen Analysis",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }
  applyCompactMode();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerCaptureShortcut(accelerator) {
  const normalized = String(accelerator || "").trim() || DEFAULT_CAPTURE_SHORTCUT;
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(normalized, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("shortcut:capture-request");
      }
    });
    return ok ? normalized : DEFAULT_CAPTURE_SHORTCUT;
  } catch {
    globalShortcut.register(DEFAULT_CAPTURE_SHORTCUT, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("shortcut:capture-request");
      }
    });
    return DEFAULT_CAPTURE_SHORTCUT;
  }
}

function applyCompactMode() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!compactModeActive) {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 460;
  const height = 740;
  const x = display.workArea.x + display.workArea.width - width - 12;
  const y = display.workArea.y + 12;
  mainWindow.setBounds({ x, y, width, height });
  mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true, "floating");
}

function engineBaseUrl() {
  return `http://127.0.0.1:${enginePort}/v1`;
}

function engineHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${launchToken}`,
  };
}

function publishEngineStatus(status) {
  engineState = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("engine:status", { status });
  }
}

async function waitForEngineReady() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${engineBaseUrl()}/health`);
      if (res.ok) {
        publishEngineStatus("online");
        return true;
      }
    } catch {
      // no-op while polling
    }
    await sleep(250);
  }
  return false;
}

async function probeEngineHealth() {
  try {
    const res = await fetch(`${engineBaseUrl()}/health`);
    if (res.ok) {
      if (engineState !== "online") {
        publishEngineStatus("online");
      }
      return true;
    }
  } catch {
    // no-op
  }
  if (engineState === "online") {
    publishEngineStatus("offline");
  }
  return false;
}

function findDevPythonCommand() {
  const engineRoot = path.join(__dirname, "..", "engine");
  const venvPythonWin = path.join(engineRoot, ".venv", "Scripts", "python.exe");
  const venvPythonUnix = path.join(engineRoot, ".venv", "bin", "python");
  if (fs.existsSync(venvPythonWin)) {
    return venvPythonWin;
  }
  if (fs.existsSync(venvPythonUnix)) {
    return venvPythonUnix;
  }
  if (process.platform === "win32") {
    return "py";
  }
  return "python3";
}

function resolveEngineLaunch() {
  if (app.isPackaged) {
    const packagedEngineExe = path.join(process.resourcesPath, "engine", "engine.exe");
    if (!fs.existsSync(packagedEngineExe)) {
      throw new Error(`Bundled engine not found: ${packagedEngineExe}`);
    }
    return {
      command: packagedEngineExe,
      args: [],
      cwd: path.dirname(packagedEngineExe),
    };
  }
  const engineRoot = path.join(__dirname, "..", "engine");
  return {
    command: findDevPythonCommand(),
    args: [path.join(engineRoot, "main.py")],
    cwd: engineRoot,
  };
}

function showEngineStartupError(error) {
  const detail = String(error?.message || error || "").trim();
  const hint = app.isPackaged
    ? "The bundled engine executable is missing or cannot start."
    : "Install Python 3.10+ or build engine/dist/engine.exe before publishing the installer.";
  dialog.showErrorBox(
    "Engine startup failed",
    `Unable to start the local analysis engine.\n\n${detail}\n\n${hint}`
  );
}

async function startEngine() {
  if (engineChild) {
    return;
  }
  publishEngineStatus("booting");
  enginePort = 41000 + Math.floor(Math.random() * 1000);
  launchToken = crypto.randomBytes(24).toString("hex");
  const launch = resolveEngineLaunch();
  let geminiApiKey = await readApiKey("gemini");
  let openaiApiKey = await readApiKey("chatgpt");
  let anthropicApiKey = await readApiKey("claude");
  const env = {
    ...process.env,
    SCREENANALYSIS_HOST: "127.0.0.1",
    SCREENANALYSIS_PORT: String(enginePort),
    SCREENANALYSIS_LAUNCH_TOKEN: launchToken,
    GEMINI_API_KEY: geminiApiKey,
    OPENAI_API_KEY: openaiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey,
  };

  try {
    engineChild = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    publishEngineStatus("offline");
    showEngineStartupError(error);
    return;
  }

  engineChild.once("error", (error) => {
    publishEngineStatus("offline");
    showEngineStartupError(error);
  });

  engineChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[engine] ${chunk}`);
  });
  engineChild.stderr.on("data", (chunk) => {
    process.stderr.write(`[engine] ${chunk}`);
  });
  engineChild.on("exit", async () => {
    engineChild = null;
    if (app.isQuitting) {
      return;
    }
    if (restartAttempts < maxRestarts) {
      restartAttempts += 1;
      publishEngineStatus("restarting");
      await sleep(750);
      await startEngine();
      return;
    }
    publishEngineStatus("offline");
  });

  const healthy = await waitForEngineReady();
  if (!healthy) {
    publishEngineStatus("offline");
  } else {
    restartAttempts = 0;
  }
}

async function stopEngine() {
  if (!engineChild) {
    return;
  }
  try {
    await fetch(`${engineBaseUrl()}/shutdown`, {
      method: "POST",
      headers: engineHeaders(),
      body: JSON.stringify({}),
    });
  } catch {
    // no-op
  }
  await sleep(250);
  if (engineChild) {
    engineChild.kill();
    engineChild = null;
  }
  publishEngineStatus("offline");
}

async function engineRequest(pathname, method = "GET", body = null) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`${engineBaseUrl()}${pathname}`, {
        method,
        headers: engineHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        const detail = json?.error ?? json?.detail?.error ?? json?.detail ?? { message: "Request failed" };
        throw new Error(detail.message || "Request failed");
      }
      return json.data;
    } catch (err) {
      lastError = err;
      if (String(err?.message || "").includes("fetch failed")) {
        await waitForEngineReady();
        await sleep(200);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Engine request failed");
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return;
  }
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    show: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setSkipTaskbar(true);
  overlayWindow.setMovable(false);
  overlayWindow.setResizable(false);
  if (process.platform !== "win32") {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.webContents.once("did-finish-load", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
      overlayWindow.show();
      overlayWindow.focus();
      overlayWindow.moveTop();
    }
  });
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.focus();
      overlayWindow.moveTop();
    }
  }, 250);
  overlayWindow.on("closed", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    overlayWindow = null;
  });
}

ipcMain.handle("engine:get-status", async () => {
  if (engineChild && engineState !== "booting" && engineState !== "restarting") {
    await probeEngineHealth();
  }
  return { status: engineState };
});
ipcMain.handle("engine:analyze", async (_evt, payload) => engineRequest("/analyze", "POST", payload));
ipcMain.handle("engine:chat", async (_evt, payload) => engineRequest("/chat", "POST", payload));
ipcMain.handle("engine:search", async (_evt, payload) => engineRequest("/search", "POST", payload));
ipcMain.handle("engine:list-models", async (_evt, provider) => engineRequest(`/providers/models?provider=${encodeURIComponent(provider || "gemini")}`));
ipcMain.handle("engine:list-records", async (_evt, payload) => {
  const limit = payload?.limit ?? 50;
  const offset = payload?.offset ?? 0;
  return engineRequest(`/records?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
});
ipcMain.handle("engine:get-record", async (_evt, recordId) => engineRequest(`/records/${recordId}?include_image=true`));
ipcMain.handle("engine:delete-record", async (_evt, recordId) => engineRequest(`/records/${recordId}`, "DELETE"));
ipcMain.handle("engine:list-templates", async () => engineRequest("/templates"));
ipcMain.handle("snip:start", async (_evt, options) => {
  try {
    compactModeActive = true;
    applyCompactMode();
    pendingSnipOptions = {
      prompt_template_id: options?.prompt_template_id || "explain_code",
      analysis_mode: options?.analysis_mode || "mock",
      model_override: options?.model_override || null,
      prompt_overrides: options?.prompt_overrides || {},
      metadata: { source: "snip-overlay", screen: 0, ...(options?.metadata || {}) },
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    await sleep(120);
    createOverlayWindow();
    return { status: "ready" };
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return { status: "error", message: err.message };
  }
});
ipcMain.handle("ui:get-compact-mode", async () => ({ active: compactModeActive }));
ipcMain.handle("ui:enter-compact-mode", async () => {
  compactModeActive = true;
  applyCompactMode();
  return { active: compactModeActive };
});
ipcMain.handle("snip:capture-region", async (_evt, bounds) => {
  try {
    const overlayBounds = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : { x: 0, y: 0 };
    const absoluteBounds = {
      x: Math.round(bounds.x + overlayBounds.x),
      y: Math.round(bounds.y + overlayBounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    const capture = await engineRequest("/capture-region", "POST", absoluteBounds);
    const image_base64 = capture.image_base64;
    const capturePayload = {
      image_base64,
      options: {
        prompt_template_id: pendingSnipOptions?.prompt_template_id || "explain_code",
        prompt_overrides: pendingSnipOptions?.prompt_overrides || {},
        metadata: pendingSnipOptions?.metadata || { source: "snip-overlay", screen: 0 },
        analysis_mode: pendingSnipOptions?.analysis_mode || "mock",
        model_override: pendingSnipOptions?.model_override || null,
      },
      bounds: absoluteBounds,
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("snip:captured", capturePayload);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.close();
        }
      }, 100);
    }
    pendingSnipOptions = null;
    return { status: "ok" };
  } catch (err) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.close();
        }
      }, 100);
    }
    pendingSnipOptions = null;
    return { status: "error", message: err.message };
  }
});
ipcMain.handle("snip:cancel", async () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.close();
      }
    }, 100);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  pendingSnipOptions = null;
  return { status: "cancelled" };
});
ipcMain.handle("settings:get", async () => {
  const settings = loadSettings();
  if (!settings.models) {
    settings.models = {
      gemini: "gemini-1.5-flash",
      chatgpt: "gpt-4.1-mini",
      claude: "claude-3-5-sonnet-20241022",
    };
  }
  if (!settings.captureShortcut) {
    settings.captureShortcut = DEFAULT_CAPTURE_SHORTCUT;
    saveSettings(settings);
  }
  const geminiApiKeySet = Boolean(await readApiKey("gemini"));
  const chatgptApiKeySet = Boolean(await readApiKey("chatgpt"));
  const claudeApiKeySet = Boolean(await readApiKey("claude"));
  return {
    ...settings,
    geminiApiKeySet,
    chatgptApiKeySet,
    claudeApiKeySet,
    savedApiKeys: {
      gemini: getSavedKeyOptions("gemini"),
      chatgpt: getSavedKeyOptions("chatgpt"),
      claude: getSavedKeyOptions("claude"),
    },
  };
});
ipcMain.handle("settings:set", async (_evt, partial) => {
  const current = loadSettings();
  const currentModels = current.models || {
    gemini: "gemini-1.5-flash",
    chatgpt: "gpt-4.1-mini",
    claude: "claude-3-5-sonnet-20241022",
  };
  const nextModels = partial?.models ? { ...currentModels, ...partial.models } : currentModels;
  const next = { ...current, ...partial };
  next.models = nextModels;
  next.captureShortcut = next.captureShortcut || DEFAULT_CAPTURE_SHORTCUT;
  saveSettings(next);
  if (Object.prototype.hasOwnProperty.call(partial || {}, "captureShortcut")) {
    next.captureShortcut = registerCaptureShortcut(next.captureShortcut);
    saveSettings(next);
  }
  return next;
});
ipcMain.handle("settings:set-api-key", async (_evt, payload) => {
  try {
    const provider = normalizeProvider(payload?.provider);
    await writeApiKey(provider, payload?.apiKey || "");
    if (provider === "chatgpt") process.env.OPENAI_API_KEY = payload?.apiKey || "";
    if (provider === "claude") process.env.ANTHROPIC_API_KEY = payload?.apiKey || "";
    if (provider === "gemini") process.env.GEMINI_API_KEY = payload?.apiKey || "";
    await stopEngine();
    await startEngine();
    return { ok: true, restarted: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle("settings:select-api-key", async (_evt, payload) => {
  try {
    await selectSavedKey(payload?.provider, payload?.keyId);
    await stopEngine();
    await startEngine();
    return { ok: true, restarted: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle("data:export-history", async () => {
  const details = [];
  let offset = 0;
  const pageSize = 200;
  while (true) {
    const records = await engineRequest(`/records?limit=${pageSize}&offset=${offset}`);
    if (!records.length) break;
    for (const record of records) {
      const detail = await engineRequest(`/records/${record.id}?include_image=false`);
      details.push(detail);
    }
    if (records.length < pageSize) break;
    offset += pageSize;
  }
  const exportDir = path.join(app.getPath("userData"), "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const exportPath = path.join(exportDir, `history-${Date.now()}.json`);
  fs.writeFileSync(exportPath, JSON.stringify(details, null, 2), "utf-8");
  return { exportPath, count: details.length };
});
ipcMain.handle("data:purge-local", async () => {
  await stopEngine();
  const dataDir = resolveDataDir();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // no-op
  }
  await startEngine();
  return { purged: true, dataDir };
});

app.whenReady().then(async () => {
  createMainWindow();
  const loaded = loadSettings();
  const activeShortcut = registerCaptureShortcut(loaded.captureShortcut || DEFAULT_CAPTURE_SHORTCUT);
  if (loaded.captureShortcut !== activeShortcut) {
    loaded.captureShortcut = activeShortcut;
    saveSettings(loaded);
  }
  await startEngine();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
    if (!engineChild) {
      await startEngine();
    }
  });
});

app.on("before-quit", async () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  await stopEngine();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
