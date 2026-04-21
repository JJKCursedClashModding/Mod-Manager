const path = require("path");

/** Absolute path to the ModManagerApp root directory. */
const APP_DIR = path.join(__dirname, "..");

const CONFIG_FILE = "config.json";
const GAME_EXE_NAME = "Jujutsu Kaisen CC.exe";
const RETOC_AES_KEY = "0xBABFB8ACBA15424956C49B4E6CE9CFA43D5924D0B82FFDF8B6D5D70BE4F9DC82";
const RETOC_ENGINE_VERSION = "UE5_1";
const REPAK_VERSION = "V11";
const REPAK_MOUNT_POINT = "../../../";

const DATA_DIR = path.join(APP_DIR, "data");
const DATATABLES_DIR = path.join(APP_DIR, "data", "datatables");
const BASE_REGISTRY_BIN = path.join(DATA_DIR, "AssetRegistry.bin");
const BUILD_DIR = path.join(APP_DIR, "build");
const TOOLS_DIR = path.join(APP_DIR, "tools");
const ASSET_MAPPINGS_USMAP = path.join(DATA_DIR, "asset-mappings.usmap");
const DEFAULT_GAME_EXE_START_DIR =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Jujutsu Kaisen CC\\Jujutsu Kaisen CC\\Binaries\\Win64";

module.exports = {
  APP_DIR,
  CONFIG_FILE,
  GAME_EXE_NAME,
  RETOC_AES_KEY,
  RETOC_ENGINE_VERSION,
  REPAK_VERSION,
  REPAK_MOUNT_POINT,
  DATA_DIR,
  DATATABLES_DIR,
  BASE_REGISTRY_BIN,
  BUILD_DIR,
  TOOLS_DIR,
  ASSET_MAPPINGS_USMAP,
  DEFAULT_GAME_EXE_START_DIR,
};
