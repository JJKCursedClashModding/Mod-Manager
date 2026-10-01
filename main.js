const { app, BrowserWindow, Menu, ipcMain } = require("electron");

app.setName("Jujutsu Kaisen Cursed Clash Mod Manager");
app.disableHardwareAcceleration();

const path = require("path");
const { registerIpcHandlers } = require("./lib/ipcHandlers");

const MOD_FILE_PATTERN = /\.(jjkmod|zip)$/i;

let mainWin = null;
/**
 * Mod files opened before the renderer was ready to receive them.
 * Delivered via the `renderer-ready` handshake (cold start) or via
 * `open-mod-file` for arrivals while the app is already running.
 */
const pendingModFiles = [];
/** Becomes true once the renderer has subscribed to `open-mod-file`. */
let rendererReady = false;

function collectModFilesFromArgv(argv) {
  return (Array.isArray(argv) ? argv : []).filter(
    (a) => typeof a === "string" && MOD_FILE_PATTERN.test(a) && !a.startsWith("--"),
  );
}

function flushPendingModFiles() {
  if (!mainWin || mainWin.webContents.isLoading() || !rendererReady || pendingModFiles.length === 0) {
    return;
  }
  const files = pendingModFiles.splice(0, pendingModFiles.length);
  mainWin.webContents.send("open-mod-file", files);
  if (mainWin.isMinimized()) {
    mainWin.restore();
  }
  mainWin.focus();
}

function forwardModFiles(files) {
  const valid = (Array.isArray(files) ? files : []).filter(
    (f) => typeof f === "string" && MOD_FILE_PATTERN.test(f),
  );
  if (valid.length === 0) {
    return;
  }
  pendingModFiles.push(...valid);
  flushPendingModFiles();
}

function createWindow() {
  rendererReady = false;
  const win = new BrowserWindow({
    title: "Jujutsu Kaisen Cursed Clash Mod Manager",
    width: 1080,
    height: 780,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#0c0e15",
    icon: path.join(__dirname, "renderer", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWin = win;
  // A reload clears renderer listeners — treat it as not-ready until the
  // fresh page handshakes again, so live arrivals queue instead of loss.
  win.webContents.on("did-start-loading", () => {
    rendererReady = false;
  });
  win.on("closed", () => {
    if (mainWin === win) {
      mainWin = null;
    }
    rendererReady = false;
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

registerIpcHandlers();

// Renderer calls this once `onOpenModFile` is subscribed. Returns any
// .jjkmod files that arrived before the subscription existed (cold start
// via double-click), so they are never lost in the did-finish-load race.
ipcMain.handle("renderer-ready", () => {
  rendererReady = true;
  const files = pendingModFiles.splice(0, pendingModFiles.length);
  if (files.length > 0 && mainWin) {
    if (mainWin.isMinimized()) {
      mainWin.restore();
    }
    mainWin.focus();
  }
  return files;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A .jjkmod opened while the app runs arrives here on Windows/Linux.
  app.on("second-instance", (_event, argv) => {
    forwardModFiles(collectModFilesFromArgv(argv));
  });
  // macOS document-open event.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    forwardModFiles([filePath]);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // A .jjkmod double-clicked to launch the app arrives via argv.
    pendingModFiles.push(...collectModFilesFromArgv(process.argv));
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
