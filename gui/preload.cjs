const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenAnalysis", {
  getEngineStatus: () => ipcRenderer.invoke("engine:get-status"),
  onEngineStatus: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("engine:status", listener);
    return () => ipcRenderer.removeListener("engine:status", listener);
  },
  analyze: (payload) => ipcRenderer.invoke("engine:analyze", payload),
  chat: (payload) => ipcRenderer.invoke("engine:chat", payload),
  search: (payload) => ipcRenderer.invoke("engine:search", payload),
  listModels: (provider) => ipcRenderer.invoke("engine:list-models", provider),
  listRecords: (payload) => ipcRenderer.invoke("engine:list-records", payload),
  getRecord: (recordId) => ipcRenderer.invoke("engine:get-record", recordId),
  deleteRecord: (recordId) => ipcRenderer.invoke("engine:delete-record", recordId),
  listTemplates: () => ipcRenderer.invoke("engine:list-templates"),
  startSnip: (options) => ipcRenderer.invoke("snip:start", options),
  onSnipCaptured: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("snip:captured", listener);
    return () => ipcRenderer.removeListener("snip:captured", listener);
  },
  onCaptureShortcutRequested: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("shortcut:capture-request", listener);
    return () => ipcRenderer.removeListener("shortcut:capture-request", listener);
  },
  captureRegion: (bounds) => ipcRenderer.invoke("snip:capture-region", bounds),
  cancelSnip: () => ipcRenderer.invoke("snip:cancel"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (partial) => ipcRenderer.invoke("settings:set", partial),
  setApiKey: (provider, apiKey) => ipcRenderer.invoke("settings:set-api-key", { provider, apiKey }),
  selectApiKey: (provider, keyId) => ipcRenderer.invoke("settings:select-api-key", { provider, keyId }),
  exportHistory: () => ipcRenderer.invoke("data:export-history"),
  purgeLocalData: () => ipcRenderer.invoke("data:purge-local"),
  getCompactMode: () => ipcRenderer.invoke("ui:get-compact-mode"),
  enterCompactMode: () => ipcRenderer.invoke("ui:enter-compact-mode"),
});
