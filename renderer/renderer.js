const settingsModalEl = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const packageModalEl = document.getElementById("packageModal");
const packageHeadingEl = document.getElementById("packageHeading");
const closePackageModalBtn = document.getElementById("closePackageModalBtn");
const packageStepTextEl = document.getElementById("packageStepText");
const packageProgressFillEl = document.getElementById("packageProgressFill");
const packageConsoleEl = document.getElementById("packageConsole");
const settingsPathsEl = document.getElementById("settingsPaths");
const modsFolderPathEl = document.getElementById("modsFolderPath");
const gameFolderPathEl = document.getElementById("gameFolderPath");
const unpackedAssetsPathEl = document.getElementById("unpackedAssetsPath");
const modListEl = document.getElementById("modList");
const packageAllBtn = document.getElementById("packageAllBtn");
const launchGameBtn = document.getElementById("launchGameBtn");
const changePathBtn = document.getElementById("changePathBtn");
const openModsFolderBtn = document.getElementById("openModsFolderBtn");
const refreshModsBtn = document.getElementById("refreshModsBtn");
const enableAllModsBtn = document.getElementById("enableAllModsBtn");
const disableAllModsBtn = document.getElementById("disableAllModsBtn");
const setUnpackedAssetsPathBtn = document.getElementById("setUnpackedAssetsPathBtn");
const clearUnpackedAssetsPathBtn = document.getElementById("clearUnpackedAssetsPathBtn");
const requirementsBadge = document.getElementById("requirementsBadge");
const openRequirementsBtn = document.getElementById("openRequirementsBtn");
const requirementsModalEl = document.getElementById("requirementsModal");
const closeRequirementsBtn = document.getElementById("closeRequirementsBtn");
const refreshRequirementsBtn = document.getElementById("refreshRequirementsBtn");
const requirementsListEl = document.getElementById("requirementsList");
const verboseOutputCheckbox = document.getElementById("verboseOutputCheckbox");

let currentModsFolder = null;
/** Last full state from main; used to restore UI after bulk actions fail. */
let lastModsState = null;
let packageModalCanClose = false;

/** Closes whichever mod Tools menu is open (set when a menu opens). */
let activeModToolsClose = null;

document.addEventListener("click", () => {
  if (activeModToolsClose) {
    activeModToolsClose();
    activeModToolsClose = null;
  }
});

function setSettingsOpen(open) {
  if (!settingsModalEl) {
    return;
  }
  settingsModalEl.hidden = !open;
}

function setPackageModalOpen(open) {
  if (!packageModalEl) {
    return;
  }
  packageModalEl.hidden = !open;
}

function setPackageModalTitle(title) {
  if (!packageHeadingEl) {
    return;
  }
  packageHeadingEl.textContent = title;
}

function setPackageProgress(progress, stepText) {
  const p = Math.max(0, Math.min(100, Number(progress) || 0));
  if (packageProgressFillEl) {
    packageProgressFillEl.style.width = `${p}%`;
  }
  if (packageStepTextEl && stepText) {
    packageStepTextEl.textContent = `${stepText} (${Math.round(p)}%)`;
  }
}

function appendPackageLog(line) {
  if (!packageConsoleEl) {
    return;
  }
  packageConsoleEl.textContent += `${line}\n`;
  packageConsoleEl.scrollTop = packageConsoleEl.scrollHeight;
}

function renderMods(mods) {
  modListEl.innerHTML = "";

  if (!mods || mods.length === 0) {
    const li = document.createElement("li");
    li.className = "mod-item";
    li.textContent = "No mods found.";
    modListEl.appendChild(li);
    return;
  }

  for (const mod of mods) {
    const li = document.createElement("li");
    li.className = "mod-item";

    const head = document.createElement("div");
    head.className = "mod-head";

    const titleBlock = document.createElement("div");
    titleBlock.className = "mod-title-block";
    const title = document.createElement("div");
    title.className = "mod-title";
    title.textContent = mod.title;
    titleBlock.appendChild(title);
    if (mod.version) {
      const ver = document.createElement("span");
      ver.className = "mod-version";
      ver.textContent = mod.version;
      titleBlock.appendChild(ver);
    }

    const toggleWrap = document.createElement("label");
    toggleWrap.className = "mod-toggle";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "mod-toggle-input";
    toggle.checked = Boolean(mod.enabled);
    toggle.setAttribute("aria-label", `${mod.enabled ? "Disable" : "Enable"} mod ${mod.title}`);
    const track = document.createElement("span");
    track.className = "mod-toggle-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("span");
    thumb.className = "mod-toggle-thumb";
    track.appendChild(thumb);
    const stateLabel = document.createElement("span");
    stateLabel.className = "mod-toggle-label";

    function syncToggleUi() {
      stateLabel.textContent = toggle.checked ? "On" : "Off";
      toggle.setAttribute("aria-label", `${toggle.checked ? "Disable" : "Enable"} mod ${mod.title}`);
      toggleWrap.classList.toggle("mod-toggle--on", toggle.checked);
    }
    syncToggleUi();

    toggle.addEventListener("change", async () => {
      syncToggleUi();
      toggle.disabled = true;
      toggleWrap.classList.add("mod-toggle--busy");
      try {
        await window.modManagerApi.setModEnabled(mod.id, toggle.checked);
      } catch {
        toggle.checked = !toggle.checked;
        syncToggleUi();
      } finally {
        toggle.disabled = false;
        toggleWrap.classList.remove("mod-toggle--busy");
      }
    });

    toggleWrap.appendChild(toggle);
    toggleWrap.appendChild(track);
    toggleWrap.appendChild(stateLabel);

    head.appendChild(titleBlock);
    head.appendChild(toggleWrap);

    const description = document.createElement("p");
    description.className = "mod-description";
    description.textContent = mod.description ?? "No description";

    const checklistEl = document.createElement("ul");
    checklistEl.className = "mod-checklist";
    checklistEl.setAttribute("aria-label", "Mod contents");
    const c = mod.checklist || {};
    const rows = [
      { key: "registry", label: "AssetRegistry.json" },
      { key: "packages", label: "Packages" },
      { key: "assets", label: "Assets" },
      { key: "datatables", label: "Datatables" },
    ];
    for (const row of rows) {
      const ok = Boolean(c[row.key]);
      const item = document.createElement("li");
      item.className = `mod-checklist-item${ok ? " mod-checklist-item--on" : " mod-checklist-item--off"}`;
      const mark = document.createElement("span");
      mark.className = "mod-checklist-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = ok ? "✓" : "○";
      const text = document.createElement("span");
      text.className = "mod-checklist-label";
      text.textContent = row.label;
      item.appendChild(mark);
      item.appendChild(text);
      checklistEl.appendChild(item);
    }

    const toolsWrap = document.createElement("div");
    toolsWrap.className = "mod-tools mod-tools--footer";

    const toolsBtn = document.createElement("button");
    toolsBtn.type = "button";
    toolsBtn.className = "mod-tools-trigger";
    toolsBtn.textContent = "Tools";
    toolsBtn.setAttribute("aria-haspopup", "menu");
    toolsBtn.setAttribute("aria-expanded", "false");
    toolsBtn.setAttribute("aria-label", `Tools menu for ${mod.title}`);

    const toolsMenu = document.createElement("div");
    toolsMenu.className = "mod-tools-menu";
    toolsMenu.setAttribute("role", "menu");
    toolsMenu.hidden = true;

    function closeToolsMenu() {
      toolsMenu.hidden = true;
      toolsBtn.setAttribute("aria-expanded", "false");
      if (activeModToolsClose === closeToolsMenu) {
        activeModToolsClose = null;
      }
    }

    function openToolsMenu() {
      if (activeModToolsClose && activeModToolsClose !== closeToolsMenu) {
        activeModToolsClose();
        activeModToolsClose = null;
      }
      toolsMenu.hidden = false;
      toolsBtn.setAttribute("aria-expanded", "true");
      activeModToolsClose = closeToolsMenu;
    }

    toolsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (toolsMenu.hidden) {
        openToolsMenu();
      } else {
        closeToolsMenu();
      }
    });

    toolsMenu.addEventListener("click", (e) => e.stopPropagation());

    // ── Open mod folder ──────────────────────────────────────────────────────
    const openFolderItem = document.createElement("button");
    openFolderItem.type = "button";
    openFolderItem.className = "mod-tools-menu-item";
    openFolderItem.setAttribute("role", "menuitem");
    openFolderItem.textContent = "Open mod folder";

    openFolderItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeToolsMenu();
      try {
        await window.modManagerApi.openModFolder(mod.fullPath);
      } catch (error) {
        alert(`Could not open mod folder:\n${error.message}`);
      }
    });

    // ── Package mod (zip) ────────────────────────────────────────────────────
    const packageZipItem = document.createElement("button");
    packageZipItem.type = "button";
    packageZipItem.className = "mod-tools-menu-item";
    packageZipItem.setAttribute("role", "menuitem");
    packageZipItem.textContent = "Package mod (zip)";

    packageZipItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeToolsMenu();

      packageZipItem.disabled = true;
      packageModalCanClose = false;
      if (closePackageModalBtn) {
        closePackageModalBtn.disabled = true;
      }
      if (packageConsoleEl) {
        packageConsoleEl.textContent = "";
      }
      setPackageModalTitle("Package Mod (zip)");
      setPackageProgress(0, "Zipping mod");
      appendPackageLog(`[info] Packaging ${mod.title} as zip…`);
      setPackageModalOpen(true);
      try {
        setPackageProgress(50, "Zipping mod");
        const result = await window.modManagerApi.packageSingleMod(mod.fullPath);
        setPackageProgress(100, "Done");
        appendPackageLog(`[done] Output: ${result.zipPath}`);
      } catch (error) {
        appendPackageLog(`[error] ${error.message}`);
      } finally {
        packageModalCanClose = true;
        if (closePackageModalBtn) {
          closePackageModalBtn.disabled = false;
        }
        packageZipItem.disabled = false;
      }
    });

    toolsMenu.appendChild(openFolderItem);
    toolsMenu.appendChild(packageZipItem);
    toolsWrap.appendChild(toolsBtn);
    toolsWrap.appendChild(toolsMenu);

    const footer = document.createElement("div");
    footer.className = "mod-item-footer";
    footer.appendChild(checklistEl);
    footer.appendChild(toolsWrap);

    li.appendChild(head);
    li.appendChild(description);
    li.appendChild(footer);
    modListEl.appendChild(li);
  }
}

function dirname(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const i = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  if (i <= 0) return null;
  return filePath.slice(0, i);
}

function setSettingsPaths(modsPath, gameExePath, unpackedAssetsPath) {
  const gameFolder = dirname(gameExePath);
  if (modsFolderPathEl) {
    if (modsPath) {
      modsFolderPathEl.hidden = false;
      modsFolderPathEl.textContent = `Mods folder: ${modsPath}`;
    } else {
      modsFolderPathEl.hidden = true;
      modsFolderPathEl.textContent = "";
    }
  }
  if (gameFolderPathEl) {
    if (gameFolder) {
      gameFolderPathEl.hidden = false;
      gameFolderPathEl.textContent = `Game folder: ${gameFolder}`;
    } else {
      gameFolderPathEl.hidden = true;
      gameFolderPathEl.textContent = "";
    }
  }
  if (unpackedAssetsPathEl) {
    if (unpackedAssetsPath) {
      unpackedAssetsPathEl.hidden = false;
      unpackedAssetsPathEl.textContent = `Unpacked assets path: ${unpackedAssetsPath}`;
    } else {
      unpackedAssetsPathEl.hidden = false;
      unpackedAssetsPathEl.textContent = "Unpacked assets path: (not set)";
    }
  }
  if (settingsPathsEl) {
    settingsPathsEl.hidden = false;
  }
}

// ── Requirements modal ────────────────────────────────────────────────────────

function setRequirementsModalOpen(open) {
  if (!requirementsModalEl) return;
  requirementsModalEl.hidden = !open;
}

/**
 * Renders the requirements list inside the modal.
 * @param {Array} statuses  Array of requirement status objects from checkAllRequirements.
 */
function renderRequirements(statuses) {
  if (!requirementsListEl) return;
  requirementsListEl.innerHTML = "";

  if (!statuses || statuses.length === 0) {
    const li = document.createElement("li");
    li.className = "req-item";
    li.textContent = "No requirements defined.";
    requirementsListEl.appendChild(li);
    return;
  }

  for (const req of statuses) {
    const li = document.createElement("li");
    li.className = "req-item";

    // Left: name + description
    const info = document.createElement("div");
    info.className = "req-info";

    const name = document.createElement("span");
    name.className = "req-name";
    name.textContent = req.name;
    info.appendChild(name);

    if (req.description) {
      const desc = document.createElement("span");
      desc.className = "req-description";
      desc.textContent = req.description;
      info.appendChild(desc);
    }

    // Right: status + action
    const actions = document.createElement("div");
    actions.className = "req-actions";

    const statusBadge = document.createElement("span");
    if (req.installed === true) {
      statusBadge.className = "req-status req-status--ok";
      statusBadge.textContent = "Installed";
    } else if (req.installed === "outdated") {
      statusBadge.className = "req-status req-status--outdated";
      statusBadge.textContent = "Outdated";
    } else if (req.installed === false) {
      statusBadge.className = "req-status req-status--missing";
      statusBadge.textContent = "Not Found";
    } else {
      statusBadge.className = "req-status req-status--unknown";
      statusBadge.textContent = "Unknown";
    }
    if (req.statusDetail) {
      statusBadge.title = req.statusDetail;
    }
    actions.appendChild(statusBadge);

    // Action buttons for missing or outdated requirements
    if (req.installed === false || req.installed === "outdated") {
      if (req.url) {
        const downloadBtn = document.createElement("button");
        downloadBtn.type = "button";
        downloadBtn.className = "req-action-btn";
        downloadBtn.textContent = "Download";
        downloadBtn.addEventListener("click", async () => {
          try {
            await window.modManagerApi.openExternalUrl(req.url);
          } catch {
            /* ignore */
          }
        });
        actions.appendChild(downloadBtn);
      }

      if (req.zipPath && req.installPath) {
        const installBtn = document.createElement("button");
        installBtn.type = "button";
        installBtn.className = "req-action-btn req-action-btn--install";
        installBtn.textContent = "Install";
        installBtn.addEventListener("click", async () => {
          installBtn.disabled = true;
          installBtn.textContent = "Installing…";
          try {
            const updated = await window.modManagerApi.installRequirement(req.id);
            renderRequirements(updated);
            updateRequirementsBadge(updated);
          } catch (error) {
            alert(`Failed to install ${req.name}:\n${error.message}`);
            installBtn.disabled = false;
            installBtn.textContent = "Install";
          }
        });
        actions.appendChild(installBtn);
      }
    }

    li.appendChild(info);
    li.appendChild(actions);
    requirementsListEl.appendChild(li);
  }
}

/**
 * Shows or hides the "Missing Requirements" badge in the header.
 * @param {Array} statuses
 */
function updateRequirementsBadge(statuses) {
  if (!requirementsBadge) return;
  const hasIssue = Array.isArray(statuses) &&
    statuses.some((s) => s.installed === false || s.installed === "outdated");
  requirementsBadge.hidden = !hasIssue;
}

async function loadAndRenderRequirements() {
  try {
    const statuses = await window.modManagerApi.checkRequirements();
    renderRequirements(statuses);
    updateRequirementsBadge(statuses);
  } catch {
    /* ignore */
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

function applyState(result) {
  currentModsFolder = result.modsFolder || null;
  const hasModsRoot = Boolean(currentModsFolder);
  const modCount = Array.isArray(result.mods) ? result.mods.length : 0;
  packageAllBtn.disabled = !hasModsRoot;
  if (launchGameBtn) {
    launchGameBtn.disabled = !result.gameLocation;
  }
  if (openModsFolderBtn) {
    openModsFolderBtn.disabled = !hasModsRoot;
  }
  if (refreshModsBtn) {
    refreshModsBtn.disabled = !hasModsRoot;
  }
  if (enableAllModsBtn) {
    enableAllModsBtn.disabled = !hasModsRoot || modCount === 0;
  }
  if (disableAllModsBtn) {
    disableAllModsBtn.disabled = !hasModsRoot || modCount === 0;
  }
  if (clearUnpackedAssetsPathBtn) {
    clearUnpackedAssetsPathBtn.disabled = !result.unpackedAssetsPath;
  }
  if (verboseOutputCheckbox && result.verboseOutput !== undefined) {
    verboseOutputCheckbox.checked = Boolean(result.verboseOutput);
  }
  setSettingsPaths(
    result.modsFolder || null,
    result.gameLocation || null,
    result.unpackedAssetsPath || null,
  );

  renderMods(result.mods || []);
  lastModsState = result;

  // Refresh requirements badge whenever state changes (game path may have changed).
  loadAndRenderRequirements();
}

async function init() {
  const result = await window.modManagerApi.initApp();
  applyState(result);
}

// ── Requirements modal event listeners ───────────────────────────────────────

openRequirementsBtn?.addEventListener("click", () => {
  setRequirementsModalOpen(true);
});

closeRequirementsBtn?.addEventListener("click", () => {
  setRequirementsModalOpen(false);
});

requirementsModalEl?.addEventListener("click", (e) => {
  if (e.target === requirementsModalEl) {
    setRequirementsModalOpen(false);
  }
});

refreshRequirementsBtn?.addEventListener("click", async () => {
  refreshRequirementsBtn.disabled = true;
  try {
    await loadAndRenderRequirements();
  } finally {
    refreshRequirementsBtn.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && requirementsModalEl && !requirementsModalEl.hidden) {
    setRequirementsModalOpen(false);
  }
});

refreshModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) {
    return;
  }
  refreshModsBtn.disabled = true;
  try {
    const result = await window.modManagerApi.refreshMods();
    applyState(result);
  } catch {
    if (lastModsState) {
      applyState(lastModsState);
    }
  }
});

enableAllModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) {
    return;
  }
  enableAllModsBtn.disabled = true;
  disableAllModsBtn.disabled = true;
  try {
    const result = await window.modManagerApi.enableAllMods();
    applyState(result);
  } catch {
    if (lastModsState) {
      applyState(lastModsState);
    }
  }
});

disableAllModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) {
    return;
  }
  enableAllModsBtn.disabled = true;
  disableAllModsBtn.disabled = true;
  try {
    const result = await window.modManagerApi.disableAllMods();
    applyState(result);
  } catch {
    if (lastModsState) {
      applyState(lastModsState);
    }
  }
});

openModsFolderBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) {
    return;
  }
  try {
    await window.modManagerApi.openModsFolder(currentModsFolder);
  } catch {
    /* ignore */
  }
});

changePathBtn.addEventListener("click", async () => {
  const result = await window.modManagerApi.changeGameLocation();
  if (!result.cancelled) {
    applyState(result);
  }
});

openSettingsBtn?.addEventListener("click", () => {
  setSettingsOpen(true);
});

closeSettingsBtn?.addEventListener("click", () => {
  setSettingsOpen(false);
});

settingsModalEl?.addEventListener("click", (e) => {
  if (e.target === settingsModalEl) {
    setSettingsOpen(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsModalEl && !settingsModalEl.hidden) {
    setSettingsOpen(false);
  }
});

closePackageModalBtn?.addEventListener("click", () => {
  if (!packageModalCanClose) {
    return;
  }
  setPackageModalOpen(false);
});

packageModalEl?.addEventListener("click", (e) => {
  if (e.target === packageModalEl && packageModalCanClose) {
    setPackageModalOpen(false);
  }
});

window.modManagerApi.onPackageProgress?.((payload) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "progress") {
    setPackageProgress(payload.progress, payload.step || "Packaging");
    return;
  }
  if (payload.type === "log") {
    const prefix = payload.stream ? `[${payload.stream}] ` : "";
    appendPackageLog(`${prefix}${payload.message ?? ""}`);
    return;
  }
  if (payload.type === "error") {
    appendPackageLog(`[error] ${payload.message ?? "Packaging failed"}`);
    return;
  }
  if (payload.type === "done") {
    appendPackageLog(`[done] ${payload.message ?? "Packaging finished"}`);
  }
});

packageAllBtn.addEventListener("click", async () => {
  if (!currentModsFolder) {
    return;
  }

  packageAllBtn.disabled = true;
  packageModalCanClose = false;
  if (closePackageModalBtn) {
    closePackageModalBtn.disabled = true;
  }
  if (packageConsoleEl) {
    packageConsoleEl.textContent = "";
  }
  setPackageModalTitle("Installing Mods");
  setPackageProgress(0, "Starting installation");
  appendPackageLog("[info] Installation started");
  setPackageModalOpen(true);

  try {
    const output = await window.modManagerApi.packageAllMods(currentModsFolder);
    appendPackageLog(`[done] Output: ${output.outputDir}`);
    if (output.gamePaksModsDir) {
      appendPackageLog(`[done] Game folder: ${output.gamePaksModsDir}`);
    }
  } catch (error) {
    appendPackageLog(`[error] ${error.message}`);
  } finally {
    packageAllBtn.disabled = false;
    packageModalCanClose = true;
    if (closePackageModalBtn) {
      closePackageModalBtn.disabled = false;
    }
  }
});

setUnpackedAssetsPathBtn?.addEventListener("click", async () => {
  const result = await window.modManagerApi.setUnpackedAssetsPath();
  if (!result.cancelled) {
    applyState(result);
  }
});

verboseOutputCheckbox?.addEventListener("change", async () => {
  try {
    await window.modManagerApi.setVerboseOutput(verboseOutputCheckbox.checked);
  } catch {
    verboseOutputCheckbox.checked = !verboseOutputCheckbox.checked;
  }
});

clearUnpackedAssetsPathBtn?.addEventListener("click", async () => {
  const ok = window.confirm(
    "Reset unpacked assets path? This clears the saved path from settings.",
  );
  if (!ok) {
    return;
  }
  try {
    const result = await window.modManagerApi.clearUnpackedAssetsPath();
    applyState(result);
  } catch {
    /* ignore */
  }
});

launchGameBtn?.addEventListener("click", async () => {
  launchGameBtn.disabled = true;
  try {
    await window.modManagerApi.launchGame();
  } catch (error) {
    alert(`Could not launch game:\n${error.message}`);
  } finally {
    launchGameBtn.disabled = !lastModsState?.gameLocation;
  }
});

init().catch(() => {});
