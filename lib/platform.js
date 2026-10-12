/**
 * platform.js — Electron-optional abstractions.
 *
 * Local Electron runs use the real `electron` module (dialogs, shell,
 * app paths). The remote host (`node server.js`, no Electron) falls back
 * to headless equivalents so the same `lib/*` code runs in both modes.
 *
 * Remote pickers can't pop a dialog on the *client*, so server callers
 * pass explicit paths instead — the `pick*` helpers below throw a
 * descriptive error when there is no Electron dialog available.
 */
"use strict";

const os = require("os");
const path = require("path");

function getElectron() {
  try {
    // eslint-disable-next-line global-require
    const electron = require("electron");
    return electron && electron.app ? electron : null;
  } catch {
    return null;
  }
}

function isElectron() {
  return Boolean(getElectron());
}

/** Writable per-user dir. Electron: app.getPath("userData"). Server: env or home dir. */
function getUserDataDir() {
  const electron = getElectron();
  if (electron) {
    return electron.app.getPath("userData");
  }
  if (process.env.JJKMM_USERDATA && process.env.JJKMM_USERDATA.trim()) {
    return process.env.JJKMM_USERDATA.trim();
  }
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".config");
  return path.join(base, "JJK CC Mod Manager");
}

function getAppVersion() {
  const electron = getElectron();
  if (electron) {
    try {
      return electron.app.getVersion();
    } catch {
      /* fall through */
    }
  }
  try {
    // eslint-disable-next-line global-require
    return require("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Open a URL in the user's browser. Server mode: no-op (client opens it). */
async function openExternal(url) {
  const electron = getElectron();
  if (electron && electron.shell) {
    await electron.shell.openExternal(url);
    return { opened: true };
  }
  return { opened: false };
}

/** Reveal a path in the OS file manager. Server mode: no-op (path is host-local). */
async function openPath(targetPath) {
  const electron = getElectron();
  if (electron && electron.shell) {
    const err = await electron.shell.openPath(targetPath);
    if (err) throw new Error(err);
    return { opened: true };
  }
  return { opened: false };
}

function noDialogError(action) {
  return new Error(
    `${action} needs a path when running as a remote host — ` +
      `pass an explicit host-local path instead of opening a dialog.`,
  );
}

module.exports = {
  isElectron,
  getUserDataDir,
  getAppVersion,
  openExternal,
  openPath,
  noDialogError,
};
