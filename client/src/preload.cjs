const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("opencomDesktopBridge", {
  setPresenceAuth: (payload) => ipcRenderer.send("rpc:auth", payload || {}),
  rpcInfo: () => ipcRenderer.invoke("rpc:info"),
  appInfo: () => ipcRenderer.invoke("desktop:app:get-info"),
  getSession: () => ipcRenderer.invoke("desktop:session:get"),
  setSession: (payload) => ipcRenderer.invoke("desktop:session:set", payload || {}),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:update:get"),
  checkForUpdates: (payload = {}) =>
    ipcRenderer.invoke("desktop:update:check", payload || {}),
  installUpdate: () => ipcRenderer.invoke("desktop:update:install"),
  getDisplaySources: () => ipcRenderer.invoke("desktop:display-sources:get").then((result) => result?.sources || []),
  pickDisplaySource: () => ipcRenderer.invoke("desktop:display-source:pick").then((result) => result?.sourceId || null),
  prompt: (text, defaultValue = "", title = "OpenCom") =>
    ipcRenderer.invoke("desktop:prompt", { text, defaultValue, title }).then((result) => result?.value ?? null)
});
