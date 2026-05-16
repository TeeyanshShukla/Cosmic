const { contextBridge, ipcRenderer } = require('electron');

console.log("✅ Preload loaded");

contextBridge.exposeInMainWorld('api', {
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  runTask: (task) => ipcRenderer.invoke('run-task', task),
  onLog: (callback) => ipcRenderer.on('agent-log', (_, msg) => callback(msg)),
  uploadDocument: (path) => ipcRenderer.invoke('upload-document', path),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  chatOnly: (msg) => ipcRenderer.invoke('chat-only', msg)
});
