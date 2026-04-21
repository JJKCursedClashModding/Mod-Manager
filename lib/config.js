const { app } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { CONFIG_FILE } = require("./constants");

function getConfigPath() {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

async function readConfig() {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

module.exports = { getConfigPath, readConfig, writeConfig };
