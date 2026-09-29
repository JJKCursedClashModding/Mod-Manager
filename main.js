const { app, BrowserWindow, Menu } = require("electron");

app.setName("Jujutsu Kaisen Cursed Clash Mod Manager");
app.disableHardwareAcceleration();

const path = require("path");
const { registerIpcHandlers } = require("./lib/ipcHandlers");

const MOD_FILE_PATTERN = /\.(jjkmod|zip)$/i;

let mainWin = null;
/** Mod files opened before the window finished loading. */
const pendingModFiles = [];

function collectModFilesFromArgv(argv) {
  return (Array.isArray(argv) ? argv : []).filter(
    (a) => typeof a === "string" && MOD_FILE_PATTERN.test(a) && !a.startsWith("--"),
  );
}

function flushPendingModFiles() {
  if (!mainWin || mainWin.webContents.isLoading() || pendingModFiles.length === 0) {
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
  win.webContents.on("did-finish-load", flushPendingModFiles);
  win.on("closed", () => {
    if (mainWin === win) {
      mainWin = null;
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

registerIpcHandlers();

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
