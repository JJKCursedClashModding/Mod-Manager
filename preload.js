const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modManagerApi", {
  initApp: () => ipcRenderer.invoke("init-app"),
  changeGameLocation: () => ipcRenderer.invoke("change-game-location"),
  setModEnabled: (modId, enabled) => ipcRenderer.invoke("set-mod-enabled", modId, enabled),
  refreshMods: () => ipcRenderer.invoke("refresh-mods"),
  enableAllMods: () => ipcRenderer.invoke("enable-all-mods"),
  disableAllMods: () => ipcRenderer.invoke("disable-all-mods"),
  setModsFolderOverride: () => ipcRenderer.invoke("set-mods-folder-override"),
  clearModsFolderOverride: () => ipcRenderer.invoke("clear-mods-folder-override"),
  setUnpackedAssetsPath: () => ipcRenderer.invoke("set-unpacked-assets-path"),
  clearUnpackedAssetsPath: () => ipcRenderer.invoke("clear-unpacked-assets-path"),
  packageAllMods: (modsFolder) => ipcRenderer.invoke("package-all-mods", modsFolder),
  onPackageProgress: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on("package-progress", handler);
    return () => ipcRenderer.removeListener("package-progress", handler);
  },
  openModsFolder: (modsFolder) => ipcRenderer.invoke("open-mods-folder", modsFolder),
  openExternalUrl: (url) => ipcRenderer.invoke("open-external-url", url),
  openModFolder: (modFolderPath) => ipcRenderer.invoke("open-mod-folder", modFolderPath),
  packageSingleMod: (modFolderPath) => ipcRenderer.invoke("package-single-mod", modFolderPath),
  setVerboseOutput: (verbose) => ipcRenderer.invoke("set-verbose-output", verbose),
  launchGame: () => ipcRenderer.invoke("launch-game"),
  checkRequirements: () => ipcRenderer.invoke("check-requirements"),
  installRequirement: (reqId) => ipcRenderer.invoke("install-requirement", reqId),
});
