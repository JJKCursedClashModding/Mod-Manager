const { app, BrowserWindow, Menu } = require("electron");

app.setName("Jujutsu Kaisen Cursed Clash Mod Manager");
app.disableHardwareAcceleration();

const path = require("path");
const { registerIpcHandlers } = require("./lib/ipcHandlers");

function createWindow() {
  const win = new BrowserWindow({
    title: "Jujutsu Kaisen Cursed Clash Mod Manager",
    width: 900,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

registerIpcHandlers();

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
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
