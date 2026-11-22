const { app } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { CONFIG_FILE } = require("./constants");

/**
 * config.json lives in userData. Robustness rules:
 * - Writes are atomic: JSON goes to a temp file which is then renamed over
 *   config.json, so a crash mid-write never leaves a truncated file.
 * - After every successful write the same content is copied to
 *   config.json.bak. If config.json is ever unreadable/corrupt, the backup is
 *   used (and restored); the corrupt file is kept as config.json.corrupt-<ts>
 *   and the problem is reported via getConfigWarning() instead of silently
 *   resetting all settings.
 * - All writes are serialized through one queue. Read-modify-write callers
 *   must use updateConfig(mutator), which reads the latest config inside the
 *   queue, so two quick changes (e.g. two mod toggles) can't lose one.
 */

function getConfigPath() {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

function getBackupPath() {
  return `${getConfigPath()}.bak`;
}

/** Last recovery notice (null when the config loaded cleanly). */
let configWarning = null;

/** Tail of the serialized write queue. */
let queue = Promise.resolve();
let tempCounter = 0;

function enqueue(task) {
  const run = queue.then(task, task);
  // Keep the chain alive regardless of this task's outcome.
  queue = run.catch(() => {});
  return run;
}

async function tryReadJsonObject(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return { ok: false, missing: error && error.code === "ENOENT", error };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, missing: false, error: new Error("config is not a JSON object") };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads config.json, falling back to config.json.bak when it is missing or
 * corrupt. Returns {} only when neither is usable (first run, or both bad).
 */
async function readConfig() {
  const configPath = getConfigPath();
  const primary = await tryReadJsonObject(configPath);
  if (primary.ok) {
    return primary.value;
  }

  const backup = await tryReadJsonObject(getBackupPath());
  if (primary.missing) {
    // First run (no config yet) or a crash between rename steps.
    return backup.ok ? backup.value : {};
  }

  // Corrupt primary: keep it for diagnosis, then recover.
  const corruptPath = `${configPath}.corrupt-${Date.now()}`;
  try {
    await fs.copyFile(configPath, corruptPath);
  } catch {
    /* best effort */
  }
  if (backup.ok) {
    configWarning =
      `Settings file was corrupt (${errorText(primary.error)}); restored the last good copy from ` +
      `${path.basename(getBackupPath())}. The corrupt file was saved as ${path.basename(corruptPath)}.`;
    console.error(`[config] ${configWarning}`);
    try {
      await enqueue(() => writeConfigNow(backup.value));
    } catch {
      /* the in-memory backup is still returned */
    }
    return backup.value;
  }
  configWarning =
    `Settings file was corrupt (${errorText(primary.error)}) and no usable backup exists; settings were reset. ` +
    `The corrupt file was saved as ${path.basename(corruptPath)}.`;
  console.error(`[config] ${configWarning}`);
  return {};
}

async function renameWithRetry(from, to) {
  // Windows: AV scanners / indexers can briefly hold config.json open.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 4 || !error || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Unqueued atomic write — only call from inside the queue. */
async function writeConfigNow(config) {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const text = JSON.stringify(config, null, 2);
  const tempPath = `${configPath}.tmp-${process.pid}-${++tempCounter}`;
  try {
    await fs.writeFile(tempPath, text, "utf8");
    await renameWithRetry(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await fs.writeFile(getBackupPath(), text, "utf8");
  } catch {
    /* backup is best effort; config.json itself was written atomically */
  }
}

/** Replaces the whole config (serialized with every other write). */
async function writeConfig(config) {
  return enqueue(() => writeConfigNow(config));
}

/**
 * Serialized read-modify-write. `mutator(config)` receives the latest config
 * and may mutate it in place or return a replacement object. Returning
 * `false` means "nothing changed" and skips the write.
 *
 * @param {(config: object) => (object|false|void|Promise<object|false|void>)} mutator
 * @returns {Promise<object>}  The config as written (or as read, when skipped).
 */
async function updateConfig(mutator) {
  return enqueue(async () => {
    const current = await readConfig();
    const result = await mutator(current);
    if (result === false) {
      return current;
    }
    const next = result && typeof result === "object" ? result : current;
    await writeConfigNow(next);
    return next;
  });
}

/** Returns (and clears) the last config recovery notice, if any. */
function takeConfigWarning() {
  const warning = configWarning;
  configWarning = null;
  return warning;
}

module.exports = { getConfigPath, readConfig, writeConfig, updateConfig, takeConfigWarning };
