/* JJK CC Mod Manager — renderer */
"use strict";

const $ = (id) => document.getElementById(id);

const settingsModalEl = $("settingsModal");
const openSettingsBtn = $("openSettingsBtn");
const closeSettingsBtn = $("closeSettingsBtn");
const packageModalEl = $("packageModal");
const packageHeadingEl = $("packageHeading");
const closePackageModalBtn = $("closePackageModalBtn");
const packageStepTextEl = $("packageStepText");
const packageProgressFillEl = $("packageProgressFill");
const packageConsoleEl = $("packageConsole");
const modsFolderPathEl = $("modsFolderPath");
const gameFolderPathEl = $("gameFolderPath");
const unpackedAssetsPathEl = $("unpackedAssetsPath");
const modListEl = $("modList");
const installModBtn = $("installModBtn");
const packageAllBtn = $("packageAllBtn");
const launchGameBtn = $("launchGameBtn");
const changePathBtn = $("changePathBtn");
const openModsFolderBtn = $("openModsFolderBtn");
const refreshModsBtn = $("refreshModsBtn");
const enableAllModsBtn = $("enableAllModsBtn");
const disableAllModsBtn = $("disableAllModsBtn");
const setUnpackedAssetsPathBtn = $("setUnpackedAssetsPathBtn");
const clearUnpackedAssetsPathBtn = $("clearUnpackedAssetsPathBtn");
const setModsFolderOverrideBtn = $("setModsFolderOverrideBtn");
const clearModsFolderOverrideBtn = $("clearModsFolderOverrideBtn");
const requirementsBadge = $("requirementsBadge");
const openRequirementsBtn = $("openRequirementsBtn");
const updateBadge = $("updateBadge");
const updateBadgeText = $("updateBadgeText");
const openLatestReleaseBtn = $("openLatestReleaseBtn");
const requirementsModalEl = $("requirementsModal");
const closeRequirementsBtn = $("closeRequirementsBtn");
const refreshRequirementsBtn = $("refreshRequirementsBtn");
const requirementsListEl = $("requirementsList");
const verboseOutputCheckbox = $("verboseOutputCheckbox");
// New UI
const modSearchInput = $("modSearchInput");
const clearSearchBtn = $("clearSearchBtn");
const modSortSelect = $("modSortSelect");
const modCountBadge = $("modCountBadge");
const statusHealthBtn = $("statusHealthBtn");
const statusHealthDot = $("statusHealthDot");
const statusHealthText = $("statusHealthText");
const statusHint = $("statusHint");
const statusLibrary = $("statusLibrary");
const statusOverlapsBtn = $("statusOverlapsBtn");
const statusOverlapsText = $("statusOverlapsText");
const statusVersionBtn = $("statusVersionBtn");
const toastRoot = $("toastRoot");
const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
const conflictsTypeFilterEl = $('conflictsTypeFilter');
const conflictTypeButtons = Array.from(
  document.querySelectorAll('#conflictsTypeFilter [data-conflict-type]')
);
const conflictsBtn = $("conflictsBtn");
const conflictsCount = $("conflictsCount");
const conflictsModalEl = $("conflictsModal");
const conflictsListEl = $("conflictsList");
const conflictsSubEl = $("conflictsSub");
const conflictsShowAllBtn = $("conflictsShowAllBtn");
const closeConflictsBtn = $("closeConflictsBtn");
const jsonCheckModalEl = $("jsonCheckModal");
const jsonCheckHeadingEl = $("jsonCheckHeading");
const jsonCheckSubEl = $("jsonCheckSub");
const jsonCheckListEl = $("jsonCheckList");
const closeJsonCheckBtn = $("closeJsonCheckBtn");
const installConfirmModalEl = $("installConfirmModal");
const installConfirmTextEl = $("installConfirmText");
const installConfirmDetailEl = $("installConfirmDetail");
const installConfirmOkBtn = $("installConfirmOkBtn");
const installConfirmCancelBtn = $("installConfirmCancelBtn");
const setupWizardModalEl = $("setupWizardModal");
const setupStepsBar = $("setupStepsBar");
const setupStepPanes = [$("setupStep1"), $("setupStep2"), $("setupStep3")];
const setupBackBtn = $("setupBackBtn");
const setupNextBtn = $("setupNextBtn");
const closeSetupWizardBtn = $("closeSetupWizardBtn");
const setupExePathEl = $("setupExePath");
const setupPickExeBtn = $("setupPickExeBtn");
const setupCleanupListEl = $("setupCleanupList");
const setupDeleteSelectedBtn = $("setupDeleteSelectedBtn");
const setupCleanupResultEl = $("setupCleanupResult");
const setupSigpatchBoxEl = $("setupSigpatchBox");
const setupInstallSigpatchBtn = $("setupInstallSigpatchBtn");
const runSetupWizardBtn = $("runSetupWizardBtn");

let currentModsFolder = null;
let currentGameExePath = null;
let currentModsFolderOverride = null;
let lastModsState = null;
let packageModalCanClose = false;
let latestReleaseUrl = null;
let activeModToolsClose = null;
let lastRequirements = [];
let appVersion = null;
let lastInstall = null; // { ok, count, time }

// Library view state
let allMods = [];
let activeFilter = "all";
let searchQuery = "";
let sortMode = "priority";

// Overlap state (enabled mods only, from main process)
let currentConflicts = { total: 0, truncated: false, conflicts: [], byMod: {}, scannedMods: 0, warnings: [] };
let conflictFilterModId = null;
let conflictTypeFilter = 'all';

function emptyConflicts() {
  return { total: 0, truncated: false, conflicts: [], byMod: {}, scannedMods: 0, warnings: [] };
}

document.addEventListener("click", () => {
  if (activeModToolsClose) {
    activeModToolsClose();
    activeModToolsClose = null;
  }
});

/* ── Toasts ─────────────────────────────────────────────── */

function showToast(kind, title, message, timeout = 4200) {
  if (!toastRoot) {
    if (kind === "error") alert(`${title}\n${message || ""}`);
    return;
  }
  const el = document.createElement("div");
  el.className = `toast toast--${kind || "info"}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = kind === "success" ? "✓" : kind === "error" ? "⚠" : "ℹ";
  el.appendChild(icon);

  const body = document.createElement("div");
  body.className = "toast-body";
  const t = document.createElement("div");
  t.className = "toast-title";
  t.textContent = title;
  body.appendChild(t);
  if (message) {
    const m = document.createElement("div");
    m.className = "toast-msg";
    m.textContent = message;
    body.appendChild(m);
  }
  el.appendChild(body);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "✕";
  close.addEventListener("click", () => dismissToast(el));
  el.appendChild(close);

  toastRoot.appendChild(el);
  while (toastRoot.children.length > 4) toastRoot.firstChild.remove();
  if (timeout > 0) setTimeout(() => dismissToast(el), timeout);
}

function dismissToast(el) {
  if (!el || !el.isConnected) return;
  el.classList.add("toast--out");
  setTimeout(() => el.remove(), 200);
}

const toastSuccess = (t, m) => showToast("success", t, m);
const toastError = (t, m) => showToast("error", t, m, 6500);
const toastInfo = (t, m) => showToast("info", t, m);

/* ── Modals ─────────────────────────────────────────────── */

function setSettingsOpen(open) {
  if (settingsModalEl) {
    settingsModalEl.hidden = !open;
    if (open) closeSettingsBtn?.focus();
  }
}

function setPackageModalOpen(open) {
  if (packageModalEl) packageModalEl.hidden = !open;
}

function setPackageModalTitle(title) {
  if (packageHeadingEl) packageHeadingEl.textContent = title;
}

function setPackageProgress(progress, stepText) {
  const p = Math.max(0, Math.min(100, Number(progress) || 0));
  if (packageProgressFillEl) packageProgressFillEl.style.width = `${p}%`;
  if (packageStepTextEl && stepText) packageStepTextEl.textContent = `${stepText} (${Math.round(p)}%)`;
}

function appendPackageLog(line, isError = false) {
  if (!packageConsoleEl) return;
  const error = isError || /^\[error\]/i.test(String(line ?? ""));
  const div = document.createElement("div");
  div.className = error ? "log-line log-error" : "log-line";
  div.textContent = String(line ?? "");
  packageConsoleEl.appendChild(div);
  packageConsoleEl.scrollTop = packageConsoleEl.scrollHeight;
}

function setRequirementsModalOpen(open) {
  if (requirementsModalEl) requirementsModalEl.hidden = !open;
}

/* ── Install confirmation (.jjkmod file association) ─────── */
let pendingInstallResolver = null;

function basenameOfPath(p) {
  if (!p || typeof p !== "string") return "this mod";
  const parts = p.split(/[/\\]/);
  return parts.pop() || p;
}

function setInstallConfirmOpen(open) {
  if (installConfirmModalEl) installConfirmModalEl.hidden = !open;
}

/**
 * Asks "Do you want to install TITLE (version)?" plus a
 * "Currently installed: version" line when already in the library.
 * Title and version are bold in distinct colors; built with textContent
 * so manifest strings can't inject HTML. Falls back to window.confirm.
 */
function confirmInstallMod({ title, version, exists, existingVersion, status }) {
  const name = title || "this mod";
  const verLabel = version ? `v${version}` : "";
  if (!installConfirmModalEl || !installConfirmOkBtn || !installConfirmCancelBtn) {
    return Promise.resolve(window.confirm(`Do you want to install ${name}${verLabel ? ` (${verLabel})` : ""}?`));
  }
  if (pendingInstallResolver) {
    pendingInstallResolver(false);
    pendingInstallResolver = null;
  }
  // Main line: Do you want to install TITLE (version)?
  if (installConfirmTextEl) {
    installConfirmTextEl.textContent = "";
    installConfirmTextEl.append("Do you want to install ");
    const nameEl = document.createElement("strong");
    nameEl.className = "install-name";
    nameEl.textContent = name;
    installConfirmTextEl.append(nameEl);
    if (verLabel) {
      installConfirmTextEl.append(" (");
      const verEl = document.createElement("strong");
      verEl.className = "install-ver";
      verEl.textContent = verLabel;
      installConfirmTextEl.append(verEl);
      installConfirmTextEl.append(")");
    }
    installConfirmTextEl.append("?");
  }
  // Status line: Currently installed: version (+ outcome hint).
  if (installConfirmDetailEl) {
    installConfirmDetailEl.textContent = "";
    if (exists) {
      installConfirmDetailEl.append("Currently installed: ");
      const curEl = document.createElement("strong");
      curEl.textContent = existingVersion ? `v${existingVersion}` : "present";
      installConfirmDetailEl.append(curEl);
      if (status === "same") {
        installConfirmDetailEl.append(" — already up to date");
      } else if (status === "update") {
        installConfirmDetailEl.append(" — will update");
      } else if (status === "older") {
        installConfirmDetailEl.append(" is newer — existing will be kept");
      } else {
        installConfirmDetailEl.append(" — will be replaced");
      }
      installConfirmDetailEl.hidden = false;
    } else {
      installConfirmDetailEl.hidden = true;
    }
  }
  setInstallConfirmOpen(true);
  installConfirmOkBtn.focus?.();
  return new Promise((resolve) => {
    pendingInstallResolver = resolve;
  });
}

function resolvePendingInstall(result) {
  if (pendingInstallResolver) {
    const r = pendingInstallResolver;
    pendingInstallResolver = null;
    setInstallConfirmOpen(false);
    r(result);
  }
}

/* ── Skeletons / empty states ───────────────────────────── */

function renderSkeletons(count = 4) {
  if (!modListEl) return;
  modListEl.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    li.className = "mod-skeleton";
    li.setAttribute("aria-hidden", "true");
    for (const w of ["60%", "90%", "40%"]) {
      const s = document.createElement("span");
      s.style.width = w;
      li.appendChild(s);
    }
    modListEl.appendChild(li);
  }
}

function renderEmptyState() {
  modListEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "mod-empty";

  const icon = document.createElement("div");
  icon.className = "mod-empty-icon";
  icon.textContent = searchQuery || activeFilter !== "all" ? "🔍" : "📦";
  li.appendChild(icon);

  const h = document.createElement("h3");
  if (!allMods.length) {
    h.textContent = currentModsFolder ? "No mods found" : "No mods folder linked";
  } else {
    h.textContent = "No mods match your search";
  }
  li.appendChild(h);

  const p = document.createElement("p");
  if (!allMods.length) {
    p.textContent = currentModsFolder
      ? "Drop mod folders into your Content/Mods directory — or install one from a .zip to get started."
      : "Link your game executable in Settings so the manager can find your Content/Mods folder.";
  } else {
    p.textContent = `Nothing matches "${searchQuery}" under the "${activeFilter}" filter. Try clearing your search or switching filters.`;
  }
  li.appendChild(p);

  const actions = document.createElement("div");
  actions.className = "mod-empty-actions";
  if (searchQuery || activeFilter !== "all") {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-small btn-secondary";
    clearBtn.textContent = "Clear search & filters";
    clearBtn.addEventListener("click", () => {
      searchQuery = "";
      if (modSearchInput) modSearchInput.value = "";
      setFilter("all");
      renderMods();
    });
    actions.appendChild(clearBtn);
  } else if (currentModsFolder) {
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "btn btn-small btn-secondary";
    installBtn.textContent = "Add mod from file…";
    installBtn.addEventListener("click", () => installModBtn?.click());
    actions.appendChild(installBtn);
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-small btn-ghost";
    openBtn.textContent = "Open mods folder";
    openBtn.addEventListener("click", () => openModsFolderBtn?.click());
    actions.appendChild(openBtn);
  } else {
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "btn btn-small btn-secondary";
    settingsBtn.textContent = "Open Settings";
    settingsBtn.addEventListener("click", () => setSettingsOpen(true));
    actions.appendChild(settingsBtn);
  }
  li.appendChild(actions);
  modListEl.appendChild(li);
}

/* ── Filtering / sorting ────────────────────────────────── */

function setFilter(f) {
  activeFilter = f;
  for (const b of filterButtons) {
    const on = b.dataset.filter === f;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
}

function getVisibleMods() {
  const q = searchQuery.trim().toLowerCase();
  let list = allMods.filter((m) => {
    if (activeFilter === "enabled" && !m.enabled) return false;
    if (activeFilter === "disabled" && m.enabled) return false;
    if (q) {
      const hay = `${m.title || ""} ${m.folderName || ""} ${m.id || ""} ${m.description || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  list = [...list];
  if (sortMode === "name") {
    list.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  } else if (sortMode === "enabled") {
    list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.priority - a.priority) || (a.title || "").localeCompare(b.title || ""));
  } else {
    list.sort((a, b) => (b.priority - a.priority) || (a.title || "").localeCompare(b.title || ""));
  }
  return list;
}

function updateCounts() {
  const total = allMods.length;
  const enabled = allMods.filter((m) => m.enabled).length;
  if (modCountBadge) modCountBadge.textContent = `${enabled} / ${total} enabled`;
  const heading = $("modsHeading");
  if (heading) heading.textContent = total === 1 ? "Mod library" : "Mod library";
  updateStatusBar();
}

/* ── Mod list rendering ─────────────────────────────────── */

const CHIP_DEFS = [
  { key: "registry", label: "Registry", title: "Contains AssetRegistry.json" },
  { key: "packages", label: "Packages", title: "Contains a matching .pak + .utoc + .ucas set in the mod root" },
  { key: "assets", label: "Assets", title: "Contains an assets/ folder with loose files" },
  { key: "datatables", label: "Datatables", title: "Contains datatables/*.json patches" },
  { key: "parameters", label: "Parameters", title: "Contains parameters/*.json patches" },
  { key: "pakAssets", label: "PAK assets", title: "Contains a pak_assets/ folder" },
  { key: "scripts", label: "Scripts", title: "Contains a scripts/ folder (ASI/DLLs loaded by Ultimate ASI Loader)" },
];

function avatarHue(id) {
  let h = 0;
  for (const ch of String(id || "?")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/** Builds the 40px mod icon (manifest `icon`) or a letter fallback tile. */
function buildModIcon(mod) {
  const wrap = document.createElement("div");
  wrap.className = "mod-icon-wrap";
  if (mod.icon) {
    const img = document.createElement("img");
    img.className = "mod-icon";
    img.src = mod.icon;
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => {
      // Broken image data → swap to the letter fallback in place.
      const avatar = document.createElement("div");
      avatar.className = "mod-avatar";
      avatar.style.setProperty("--avatar-hue", avatarHue(mod.id));
      avatar.textContent = (mod.title || mod.id || "?").trim().charAt(0).toUpperCase() || "?";
      avatar.setAttribute("aria-hidden", "true");
      img.replaceWith(avatar);
    });
    wrap.appendChild(img);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "mod-avatar";
    avatar.style.setProperty("--avatar-hue", avatarHue(mod.id));
    avatar.textContent = (mod.title || mod.id || "?").trim().charAt(0).toUpperCase() || "?";
    avatar.setAttribute("aria-hidden", "true");
    wrap.appendChild(avatar);
  }
  const dot = document.createElement("span");
  dot.className = `mod-icon-dot${mod.enabled ? " mod-icon-dot--on" : ""}`;
  dot.title = mod.enabled ? "Enabled" : "Disabled";
  wrap.appendChild(dot);
  // Non-default priority lives here instead of the title row: a quiet
  // corner badge. Ordering is already visible via sort + conflict winners.
  if (mod.priority) {
    const badge = document.createElement("span");
    badge.className = "mod-priority-badge";
    badge.textContent = String(mod.priority);
    badge.title = `Load priority ${mod.priority} — higher wins file conflicts`;
    wrap.appendChild(badge);
  }
  return wrap;
}

function renderMods() {
  if (!modListEl) return;
  modListEl.innerHTML = "";
  updateCounts();

  const visible = getVisibleMods();
  if (!visible.length) {
    renderEmptyState();
    return;
  }

  for (const mod of visible) {
    const li = document.createElement("li");
    li.className = `mod-item${mod.enabled ? " mod-item--on" : ""}`;
    li.dataset.modId = mod.id;

    // ── Head ──
    const head = document.createElement("div");
    head.className = "mod-head";

    head.appendChild(buildModIcon(mod));
    const dot = head.querySelector(".mod-icon-dot");

    const titleBlock = document.createElement("div");
    titleBlock.className = "mod-title-block";
    const titleRow = document.createElement("div");
    titleRow.className = "mod-title-row";
    const title = document.createElement("span");
    title.className = "mod-title";
    title.textContent = mod.title || mod.id;
    title.title = mod.title || mod.id;
    titleRow.appendChild(title);
    if (mod.version) {
      const ver = document.createElement("span");
      ver.className = "mod-version";
      ver.textContent = `v${mod.version}`;
      ver.title = `Version ${mod.version}`;
      titleRow.appendChild(ver);
    }
    titleBlock.appendChild(titleRow);

    const folder = document.createElement("span");
    folder.className = "mod-folder";
    folder.textContent = mod.folderName || mod.id;
    folder.title = mod.fullPath || mod.folderName || mod.id;
    titleBlock.appendChild(folder);
    head.appendChild(titleBlock);

    const headRight = document.createElement("div");
    headRight.className = "mod-head-right";

    // Toggle
    const toggleWrap = document.createElement("label");
    toggleWrap.className = `mod-toggle${mod.enabled ? " mod-toggle--on" : ""}`;
    toggleWrap.title = mod.enabled ? "Click to disable" : "Click to enable";
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
    stateLabel.textContent = toggle.checked ? "On" : "Off";

    const syncToggleUi = () => {
      stateLabel.textContent = toggle.checked ? "On" : "Off";
      toggle.setAttribute("aria-label", `${toggle.checked ? "Disable" : "Enable"} mod ${mod.title}`);
      toggleWrap.classList.toggle("mod-toggle--on", toggle.checked);
      li.classList.toggle("mod-item--on", toggle.checked);
      if (dot) {
        dot.classList.toggle("mod-icon-dot--on", toggle.checked);
        dot.title = toggle.checked ? "Enabled" : "Disabled";
      }
    };

    toggle.addEventListener("change", async () => {
      syncToggleUi();
      toggle.disabled = true;
      toggleWrap.classList.add("mod-toggle--busy");
      try {
        const res = await window.modManagerApi.setModEnabled(mod.id, toggle.checked);
        mod.enabled = toggle.checked;
        if (res && res.conflicts) {
          currentConflicts = res.conflicts;
          updateConflictsUI();
          updateConflictBadges();
        }
        updateCounts();
        const enabledCount = allMods.filter((m) => m.enabled).length;
        if (packageAllBtn) {
          packageAllBtn.disabled = !currentModsFolder || enabledCount === 0;
          packageAllBtn.title = enabledCount
            ? `Merge and install ${enabledCount} enabled mod${enabledCount === 1 ? "" : "s"} into the game`
            : "Enable at least one mod first";
        }
        if (!matchesCurrentFilter(mod)) renderMods();
      } catch {
        toggle.checked = !toggle.checked;
        syncToggleUi();
        toastError("Toggle failed", `Could not ${toggle.checked ? "enable" : "disable"} "${mod.title}".`);
      } finally {
        toggle.disabled = false;
        toggleWrap.classList.remove("mod-toggle--busy");
      }
    });

    toggleWrap.append(toggle, track, stateLabel);
    headRight.appendChild(toggleWrap);
    head.appendChild(headRight);
    li.appendChild(head);

    // ── Description ──
    if (mod.description) {
      const description = document.createElement("p");
      description.className = "mod-description";
      description.textContent = mod.description;
      description.title = mod.description;
      li.appendChild(description);
    }

    // ── Footer: chips + tools ──
    const footer = document.createElement("div");
    footer.className = "mod-item-footer";

    const chips = document.createElement("div");
    chips.className = "mod-chips";
    const c = mod.checklist || {};
    for (const def of CHIP_DEFS) {
      const ok = Boolean(c[def.key]);
      const chip = document.createElement("span");
      chip.className = `chip ${ok ? "chip--on" : "chip--off"}`;
      chip.title = `${def.label}: ${ok ? "present" : "not present"} — ${def.title}`;
      const dotEl = document.createElement("i");
      chip.appendChild(dotEl);
      const label = document.createElement("span");
      label.textContent = def.label;
      chip.appendChild(label);
      chips.appendChild(chip);
    }
    footer.appendChild(chips);

    const overlap = currentConflicts.byMod && currentConflicts.byMod[mod.id];
    if (overlap && overlap.total > 0 && mod.enabled) {
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "conflict-badge";
      badge.title = `${overlap.total} overlapping file${overlap.total === 1 ? "" : "s"} with other enabled mods — click to inspect`;
      badge.setAttribute("aria-label", `Show ${overlap.total} overlaps for ${mod.title}`);
      const warn = document.createElement("span");
      warn.setAttribute("aria-hidden", "true");
      warn.textContent = "⚠";
      badge.appendChild(warn);
      const tx = document.createElement("span");
      tx.textContent = `${overlap.total} overlap${overlap.total === 1 ? "" : "s"}`;
      badge.appendChild(tx);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        openConflictsModal(mod.id);
      });
      footer.appendChild(badge);
    }

    footer.appendChild(buildToolsMenu(mod));
    li.appendChild(footer);
    modListEl.appendChild(li);
  }
}

function matchesCurrentFilter(mod) {
  if (activeFilter === "enabled" && !mod.enabled) return false;
  if (activeFilter === "disabled" && mod.enabled) return false;
  return true;
}

function buildToolsMenu(mod) {
  const toolsWrap = document.createElement("div");
  toolsWrap.className = "mod-tools mod-tools--footer";

  const toolsBtn = document.createElement("button");
  toolsBtn.type = "button";
  toolsBtn.className = "mod-tools-trigger";
  toolsBtn.innerHTML = `<span aria-hidden="true">⋯</span><span>Tools</span>`;
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
    if (activeModToolsClose === closeToolsMenu) activeModToolsClose = null;
  }
  function openToolsMenu() {
    if (activeModToolsClose && activeModToolsClose !== closeToolsMenu) {
      activeModToolsClose();
      activeModToolsClose = null;
    }
    toolsMenu.hidden = false;
    toolsBtn.setAttribute("aria-expanded", "true");
    activeModToolsClose = closeToolsMenu;
    fitToolsMenu(toolsWrap, toolsMenu);
  }

  toolsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (toolsMenu.hidden) openToolsMenu();
    else closeToolsMenu();
  });
  toolsMenu.addEventListener("click", (e) => e.stopPropagation());

  const addItem = (label, icon, handler, disabled = false) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mod-tools-menu-item";
    item.setAttribute("role", "menuitem");
    item.disabled = disabled;
    const ic = document.createElement("span");
    ic.setAttribute("aria-hidden", "true");
    ic.textContent = icon;
    item.appendChild(ic);
    const tx = document.createElement("span");
    tx.textContent = label;
    item.appendChild(tx);
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeToolsMenu();
      await handler(item);
    });
    toolsMenu.appendChild(item);
    return item;
  };

  addItem("Open mod folder", "📁", async () => {
    try {
      await window.modManagerApi.openModFolder(mod.fullPath);
    } catch (error) {
      toastError("Could not open folder", error.message);
    }
  });

  addItem("Copy mod path", "⧉", async () => {
    try {
      await navigator.clipboard.writeText(mod.fullPath);
      toastSuccess("Path copied", mod.fullPath);
    } catch {
      toastError("Copy failed", "Could not copy the mod path to the clipboard.");
    }
  });

  addItem("Create manifest.json", "📝", async (item) => {
    item.disabled = true;
    try {
      const result = await window.modManagerApi.createModManifest(mod.fullPath);
      if (result && result.created) {
        toastSuccess("manifest.json created", result.manifestPath);
        try {
          const state = await window.modManagerApi.refreshMods();
          applyState(state);
        } catch {
          // Refresh failure is non-fatal — the file was still created.
        }
      } else {
        toastInfo("manifest.json already exists", (result && result.manifestPath) || mod.fullPath);
      }
    } catch (error) {
      toastError("Could not create manifest.json", error.message);
    } finally {
      item.disabled = false;
    }
  });

  addItem("Check JSONs for errors", "🔍", async (item) => {
    item.disabled = true;
    try {
      const result = await window.modManagerApi.validateModJson(mod.fullPath);
      renderJsonCheckResults(mod, result);
      setJsonCheckModalOpen(true);
      const bad = result && Array.isArray(result.errors) ? result.errors.length : 0;
      const total = result && Array.isArray(result.checked) ? result.checked.length : 0;
      if (bad > 0) {
        toastError("JSON errors found", `${bad} of ${total} file${total === 1 ? "" : "s"} in “${mod.title}” failed to parse.`);
      } else if (total === 0) {
        toastInfo("No JSON files", `“${mod.title}” contains no .json files to check.`);
      } else {
        toastSuccess("JSON check passed", `${total} file${total === 1 ? "" : "s"} in “${mod.title}” are valid.`);
      }
    } catch (error) {
      toastError("JSON check failed", error.message);
    } finally {
      item.disabled = false;
    }
  });

  addItem("Package mod (jjkmod)", "📦", async (item) => {
    // Ask where to save first, so cancelling never opens the progress modal.
    let savePath;
    try {
      const pick = await window.modManagerApi.pickSaveJjkmodPath(mod.fullPath);
      if (!pick || pick.cancelled || !pick.filePath) return;
      savePath = pick.filePath;
    } catch (error) {
      toastError("Packaging failed", error.message);
      return;
    }
    item.disabled = true;
    packageModalCanClose = false;
    if (closePackageModalBtn) closePackageModalBtn.disabled = true;
    if (packageConsoleEl) packageConsoleEl.textContent = "";
    setPackageModalTitle(`Package — ${mod.title}`);
    setPackageProgress(4, "Building jjkmod");
    appendPackageLog(`[info] Packaging ${mod.title} as jjkmod…`);
    setPackageModalOpen(true);
    try {
      setPackageProgress(50, "Building jjkmod");
      const result = await window.modManagerApi.packageSingleMod(mod.fullPath, savePath);
      const outputPath = result.jjkmodPath || result.zipPath;
      setPackageProgress(100, "Done");
      appendPackageLog(`[done] Output: ${outputPath}`);
      toastSuccess("Mod packaged", outputPath);
    } catch (error) {
      appendPackageLog(`[error] ${error.message}`);
      toastError("Packaging failed", error.message);
    } finally {
      packageModalCanClose = true;
      if (closePackageModalBtn) closePackageModalBtn.disabled = false;
      item.disabled = false;
    }
  });

  toolsWrap.append(toolsBtn, toolsMenu);
  return toolsWrap;
}

/**
 * Flips a footer Tools menu below its trigger when there isn't enough room
 * above it (e.g. the topmost mod card, where the scroll container would
 * otherwise clip the upward-opening menu). Runs on every open so scrolling
 * or resizing is always accounted for.
 */
function fitToolsMenu(toolsWrap, toolsMenu) {
  toolsMenu.classList.remove("mod-tools-menu--below");
  const scroller = modListEl?.closest(".app") ?? document.documentElement;
  const view = scroller.getBoundingClientRect();
  const menuH = toolsMenu.getBoundingClientRect().height;
  const trig = toolsWrap.getBoundingClientRect();
  const roomAbove = trig.top - view.top;
  const roomBelow = view.bottom - trig.bottom;
  // Default direction is above; flip below only when above clips and below is roomier.
  if (roomAbove < menuH + 6 && roomBelow > roomAbove) {
    toolsMenu.classList.add("mod-tools-menu--below");
  }
}

/* ── Overlap (conflicts) UI ───────────────────────────────── */

const CONFLICT_TYPE_LABELS = {
  datatable: 'Row',
  parameter: 'Parameter',
  asset: 'Asset',
  pakAsset: 'PAK',
  scripts: 'Script',
  registry: 'Registry',
  prebuilt: 'Package',
};

// Type tabs in the overlaps modal — same .segmented design as the
// All / Enabled / Disabled library tabs.
const CONFLICT_TYPE_FILTER_DEFS = [
  { value: 'all', label: 'All' },
  { value: 'datatable', label: 'Rows' },
  { value: 'parameter', label: 'Parameters' },
  { value: 'asset', label: 'Assets' },
  { value: 'pakAsset', label: 'PAK' },
  { value: 'scripts', label: 'Scripts' },
  { value: 'registry', label: 'Registry' },
  { value: 'prebuilt', label: 'Packages' },
];

function setConflictsModalOpen(open) {
  if (conflictsModalEl) conflictsModalEl.hidden = !open;
}

function updateConflictsUI() {
  const total = currentConflicts.total || 0;
  if (conflictsBtn) conflictsBtn.hidden = total === 0;
  if (conflictsCount) {
    conflictsCount.textContent = `${total} overlap${total === 1 ? '' : 's'}`;
  }
  if (conflictsBtn) {
    conflictsBtn.title = total
      ? `${total} overlapping file${total === 1 ? "" : "s"} between enabled mods — click to inspect`
      : "No overlaps between enabled mods";
  }
  updateStatusBar();
}

/** Refreshes per-card overlap badges in place (no full re-render). */
function updateConflictBadges() {
  if (!modListEl) return;
  for (const li of modListEl.querySelectorAll(".mod-item[data-mod-id]")) {
    const modId = li.dataset.modId;
    const mod = allMods.find((m) => m.id === modId);
    const overlap = currentConflicts.byMod && currentConflicts.byMod[modId];
    const want = Boolean(overlap && overlap.total > 0 && mod && mod.enabled);
    let badge = li.querySelector(".conflict-badge");
    if (!want) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      const footer = li.querySelector(".mod-item-footer");
      if (!footer) continue;
      badge = document.createElement("button");
      badge.type = "button";
      badge.className = "conflict-badge";
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        openConflictsModal(modId);
      });
      footer.insertBefore(badge, footer.lastElementChild);
    }
    badge.title = `${overlap.total} overlapping file${overlap.total === 1 ? "" : "s"} with other enabled mods — click to inspect`;
    badge.setAttribute("aria-label", `Show ${overlap.total} overlaps for ${mod ? mod.title : modId}`);
    badge.innerHTML = "";
    const warn = document.createElement("span");
    warn.setAttribute("aria-hidden", "true");
    warn.textContent = "⚠";
    const tx = document.createElement("span");
    tx.textContent = `${overlap.total} overlap${overlap.total === 1 ? "" : "s"}`;
    badge.append(warn, tx);
  }
}

function openConflictsModal(filterModId = null) {
  conflictFilterModId = filterModId;
  // Always start on All so every overlap (including assets) is visible;
  // the user can then narrow by type.
  conflictTypeFilter = 'all';
  renderConflictsList();
  setConflictsModalOpen(true);
}

/** Overlaps after the per-mod filter, before the type filter (for tab counts). */
function getModFilteredConflicts() {
  const all = currentConflicts.conflicts || [];
  if (!conflictFilterModId) return all;
  return all.filter((c) => (c.mods || []).some((m) => m.id === conflictFilterModId));
}

function setConflictTypeFilter(value) {
  conflictTypeFilter = value || 'all';
  for (const b of conflictTypeButtons) {
    const on = (b.dataset.conflictType || 'all') === conflictTypeFilter;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  renderConflictsList();
}

/** Refreshes type-tab labels with live counts from the mod-filtered set. */
function updateConflictTypeTabs(modFiltered) {
  const counts = { all: modFiltered.length };
  for (const c of modFiltered) {
    counts[c.type] = (counts[c.type] || 0) + 1;
  }
  for (const b of conflictTypeButtons) {
    const value = b.dataset.conflictType || 'all';
    const def = CONFLICT_TYPE_FILTER_DEFS.find((d) => d.value === value);
    const n = counts[value] || 0;
    b.textContent = value === 'all' ? `All (${n})` : `${def ? def.label : value} (${n})`;
    b.disabled = n === 0 && value !== 'all' && value !== conflictTypeFilter;
    const on = value === conflictTypeFilter;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (conflictsTypeFilterEl) conflictsTypeFilterEl.hidden = modFiltered.length === 0;
}

function renderConflictsList() {
  if (!conflictsListEl) return;
  conflictsListEl.innerHTML = '';

  const modFiltered = getModFilteredConflicts();
  updateConflictTypeTabs(modFiltered);
  const list =
    conflictTypeFilter && conflictTypeFilter !== 'all'
      ? modFiltered.filter((c) => c.type === conflictTypeFilter)
      : modFiltered;

  if (conflictsShowAllBtn) conflictsShowAllBtn.hidden = !conflictFilterModId;
  if (conflictsSubEl) {
    const typeDef = CONFLICT_TYPE_FILTER_DEFS.find((d) => d.value === conflictTypeFilter);
    const typeSuffix =
      conflictTypeFilter && conflictTypeFilter !== 'all'
        ? ` — ${typeDef ? typeDef.label : conflictTypeFilter} (${list.length})`
        : '';
    if (conflictFilterModId) {
      const mod = allMods.find((m) => m.id === conflictFilterModId);
      conflictsSubEl.textContent = `Overlaps involving “${mod ? mod.title : conflictFilterModId}” (${modFiltered.length})${typeSuffix}`;
    } else {
      conflictsSubEl.textContent = currentConflicts.total
        ? `${currentConflicts.total} overlapping file${currentConflicts.total === 1 ? '' : 's'} across ${currentConflicts.scannedMods} enabled mod${currentConflicts.scannedMods === 1 ? '' : 's'}${typeSuffix}`
        : 'Enabled mods writing to the same path or row';
    }
  }

  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'conflicts-empty';
    if (conflictTypeFilter && conflictTypeFilter !== 'all') {
      const typeDef = CONFLICT_TYPE_FILTER_DEFS.find((d) => d.value === conflictTypeFilter);
      li.textContent = conflictFilterModId
        ? `No ${typeDef ? typeDef.label.toLowerCase() : conflictTypeFilter} overlaps involve this mod.`
        : `No ${typeDef ? typeDef.label.toLowerCase() : conflictTypeFilter} overlaps — try another type.`;
    } else {
      li.textContent = conflictFilterModId
        ? 'No overlaps involve this mod.'
        : 'No overlaps — enabled mods touch distinct files and rows. ✓';
    }
    conflictsListEl.appendChild(li);
    return;
  }

  for (const c of list) {
    const li = document.createElement("li");
    li.className = "conflict-item";

    const top = document.createElement("div");
    top.className = "conflict-top";
    const tag = document.createElement("span");
    tag.className = `conflict-type conflict-type--${c.type}`;
    tag.textContent = CONFLICT_TYPE_LABELS[c.type] || c.type;
    tag.title = conflictTypeHint(c.type);
    top.appendChild(tag);
    const key = document.createElement("span");
    key.className = "conflict-key";
    key.textContent = c.key;
    key.title = c.key;
    top.appendChild(key);
    li.appendChild(top);

    const modsRow = document.createElement("div");
    modsRow.className = "conflict-mods";
    // Winner last (pipeline order) — display winner first for scannability.
    const ordered = [...(c.mods || [])].sort((a, b) => (a.id === c.winnerId ? 1 : b.id === c.winnerId ? -1 : b.priority - a.priority));
    for (const m of ordered) {
      const chip = document.createElement("span");
      chip.className = `conflict-mod${m.id === c.winnerId ? " conflict-mod--winner" : ""}`;
      chip.title = m.id === c.winnerId ? "Highest priority — wins this file/row" : "Overridden on this file/row";
      const nm = document.createElement("span");
      nm.textContent = `${m.id === c.winnerId ? "★ " : ""}${m.title || m.id}`;
      chip.appendChild(nm);
      const pri = document.createElement("span");
      pri.className = "conflict-mod-pri";
      pri.textContent = `P${m.priority ?? 0}`;
      chip.appendChild(pri);
      modsRow.appendChild(chip);
    }
    li.appendChild(modsRow);
    conflictsListEl.appendChild(li);
  }
}

function conflictTypeHint(type) {
  switch (type) {
    case "datatable": return "Same datatable row key in 2+ mods — higher priority value wins";
    case "parameter": return "Same parameters/ row key in 2+ mods — higher priority value wins";
    case "asset": return "Same assets/ path in 2+ mods — higher priority file overwrites";
    case "pakAsset": return "Same pak_assets/ path in 2+ mods — higher priority file overwrites";
    case "scripts": return "Same scripts/ path in 2+ mods — higher priority file overwrites in game scripts/";
    case "registry": return "Same AssetRegistry objectName in 2+ mods — higher priority entry wins";
    case "prebuilt": return "Same prebuilt package file name in 2+ mods — higher priority file overwrites in ~mods";
    default: return "Overlapping file between enabled mods";
  }
}

/* ── JSON check modal (per-mod Tools → Check JSONs) ─────── */

function setJsonCheckModalOpen(open) {
  if (jsonCheckModalEl) jsonCheckModalEl.hidden = !open;
}

/**
 * Renders per-file JSON validation results: errored files first (with the
 * parser message), then the files that passed. Built with textContent so
 * file contents in error messages can't inject HTML.
 */
function renderJsonCheckResults(mod, result) {
  const checked = (result && Array.isArray(result.checked) ? result.checked : []).slice().sort((a, b) => a.localeCompare(b));
  const errors = result && Array.isArray(result.errors) ? result.errors : [];
  const badSet = new Set(errors.map((e) => e && e.file));
  const title = (mod && (mod.title || mod.id)) || (result && result.modId) || "Mod";
  if (jsonCheckHeadingEl) jsonCheckHeadingEl.textContent = `JSON check — ${title}`;
  if (jsonCheckSubEl) {
    if (!checked.length) {
      jsonCheckSubEl.textContent = "No .json files found in this mod.";
    } else if (!errors.length) {
      jsonCheckSubEl.textContent = `All ${checked.length} JSON file${checked.length === 1 ? "" : "s"} are valid.`;
    } else {
      jsonCheckSubEl.textContent = `${errors.length} of ${checked.length} JSON file${checked.length === 1 ? "" : "s"} failed to parse — fix these before packaging.`;
    }
  }
  if (!jsonCheckListEl) return;
  jsonCheckListEl.innerHTML = "";
  if (!checked.length) {
    const li = document.createElement("li");
    li.className = "conflicts-empty";
    li.textContent = "Nothing to check — this mod contains no .json files.";
    jsonCheckListEl.appendChild(li);
    return;
  }
  const ordered = [
    ...checked.filter((f) => badSet.has(f)),
    ...checked.filter((f) => !badSet.has(f)),
  ];
  const errorByFile = new Map(errors.map((e) => [e && e.file, e && e.message]));
  for (const file of ordered) {
    const bad = badSet.has(file);
    const li = document.createElement("li");
    li.className = `json-check-item${bad ? " json-check-item--error" : " json-check-item--ok"}`;
    const top = document.createElement("div");
    top.className = "json-check-top";
    const badge = document.createElement("span");
    badge.className = `json-check-badge${bad ? " json-check-badge--error" : " json-check-badge--ok"}`;
    badge.textContent = bad ? "Error" : "OK";
    top.appendChild(badge);
    const name = document.createElement("span");
    name.className = "json-check-file";
    name.textContent = file;
    name.title = file;
    top.appendChild(name);
    li.appendChild(top);
    if (bad) {
      const msg = document.createElement("div");
      msg.className = "json-check-error";
      msg.textContent = errorByFile.get(file) || "Invalid JSON.";
      li.appendChild(msg);
    }
    jsonCheckListEl.appendChild(li);
  }
}

/* ── Paths / status bar ─────────────────────────────────── */

function dirname(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const i = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  if (i <= 0) return null;
  return filePath.slice(0, i);
}

function setSettingsPaths(modsPath, gameExePath, unpackedAssetsPath, modsFolderOverride) {
  const gameFolder = dirname(gameExePath);
  if (gameFolderPathEl) {
    gameFolderPathEl.hidden = false;
    if (gameFolder) {
      gameFolderPathEl.classList.remove("path-line--empty");
      gameFolderPathEl.textContent = gameFolder;
      gameFolderPathEl.title = gameExePath;
    } else {
      gameFolderPathEl.classList.add("path-line--empty");
      gameFolderPathEl.textContent = "No game linked yet — choose your Jujutsu Kaisen CC.exe.";
    }
  }
  if (modsFolderPathEl) {
    modsFolderPathEl.hidden = false;
    if (modsPath) {
      modsFolderPathEl.classList.remove("path-line--empty");
      modsFolderPathEl.textContent = modsPath + (modsFolderOverride ? "  (custom)" : "");
      modsFolderPathEl.title = modsPath;
    } else {
      modsFolderPathEl.classList.add("path-line--empty");
      modsFolderPathEl.textContent = "(not available)";
    }
  }
  if (unpackedAssetsPathEl) {
    unpackedAssetsPathEl.hidden = false;
    if (unpackedAssetsPath) {
      unpackedAssetsPathEl.classList.remove("path-line--empty");
      unpackedAssetsPathEl.textContent = unpackedAssetsPath;
      unpackedAssetsPathEl.title = unpackedAssetsPath;
    } else {
      unpackedAssetsPathEl.classList.add("path-line--empty");
      unpackedAssetsPathEl.textContent = "(not set — optional)";
    }
  }
  if (clearModsFolderOverrideBtn) {
    clearModsFolderOverrideBtn.disabled = !modsFolderOverride;
  }

  currentGameExePath = gameExePath || null;
  currentModsFolderOverride = modsFolderOverride || null;
  updateStatusBar();
}

/* ── Status bar v2 ────────────────────────────────────── */

function requirementIssues() {
  if (!Array.isArray(lastRequirements)) return [];
  return lastRequirements.filter((s) => s && (s.installed === false || s.installed === "outdated"));
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function updateStatusBar() {
  const issues = requirementIssues();
  const total = allMods.length;
  const enabled = allMods.filter((m) => m.enabled).length;
  const overlaps = (currentConflicts && currentConflicts.total) || 0;
  const modsTip = currentModsFolder || "(no mods folder)";
  const gameTip = currentGameExePath || "(no game linked)";

  // — Health (left, clickable): game > mods folder > requirements > ready —
  let healthText = "Ready";
  let healthOk = true;
  let healthTitle = "";
  let healthAction = "settings";
  if (!currentGameExePath) {
    healthText = "No game linked";
    healthOk = false;
    healthTitle = "Choose your Jujutsu Kaisen CC.exe in Settings";
    healthAction = "settings";
  } else if (!currentModsFolder) {
    healthText = "No mods folder";
    healthOk = false;
    healthTitle = `Game linked but mods folder unavailable\nGame: ${gameTip}`;
    healthAction = "settings";
  } else if (issues.length > 0) {
    healthOk = false;
    healthAction = "requirements";
    if (issues.length === 1 && issues[0].name) {
      healthText = `${issues[0].name} — action needed`;
    } else {
      healthText = `${issues.length} requirement${issues.length === 1 ? "" : "s"} need attention`;
    }
    healthTitle = `${issues.map((s) => `${s.name}: ${s.statusDetail || s.installed}`).join("\n")}\nClick to open Requirements`;
  } else {
    healthTitle = `Mods: ${modsTip}\nGame: ${gameTip}\nClick to open Settings`;
  }
  if (statusHealthText) statusHealthText.textContent = healthText;
  if (statusHealthDot) statusHealthDot.className = `status-dot${healthOk ? " status-dot--ok" : " status-dot--warn"}`;
  if (statusHealthBtn) {
    statusHealthBtn.title = healthTitle;
    statusHealthBtn.dataset.action = healthAction;
  }

  // — Hint (center, contextual) —
  let hint = "Tip: higher priority mods win file conflicts";
  if (!currentGameExePath) hint = "Link your game EXE in Settings to begin";
  else if (!currentModsFolder) hint = "Could not find mods folder — check Settings";
  else if (issues.length > 0) hint = "Requirements need attention — click status to fix";
  else if (total === 0) hint = "Drop mod folders into Content/Mods — or Add mod from file";
  else if (enabled === 0) hint = "All mods disabled — enable at least one to install";
  else if (overlaps > 0) hint = `${overlaps} overlap${overlaps === 1 ? "" : "s"} — higher priority wins, click to inspect`;
  else if (lastInstall) {
    hint = lastInstall.ok
      ? `Installed ${lastInstall.count} mod${lastInstall.count === 1 ? "" : "s"} • ${timeAgo(lastInstall.time)} — ready to play`
      : `Last install failed • ${timeAgo(lastInstall.time)}`;
  }
  if (statusHint) {
    statusHint.textContent = hint;
    statusHint.title = hint;
    statusHint.style.cursor = overlaps > 0 && issues.length === 0 && currentGameExePath && currentModsFolder ? "pointer" : "";
  }

  // — Library (right) —
  if (statusLibrary) statusLibrary.textContent = `${enabled} / ${total} enabled`;
  const showOverlaps = overlaps > 0;
  if (statusOverlapsBtn) statusOverlapsBtn.hidden = !showOverlaps;
  if (statusOverlapsText) statusOverlapsText.textContent = `${overlaps} overlap${overlaps === 1 ? "" : "s"}`;
  if (statusOverlapsBtn && showOverlaps) {
    statusOverlapsBtn.title = `${overlaps} overlapping file${overlaps === 1 ? "" : "s"} between enabled mods — click to inspect`;
  }

  // — Version (far right) —
  if (statusVersionBtn) {
    if (appVersion) {
      statusVersionBtn.textContent = `v${appVersion}`;
      if (latestReleaseUrl) {
        statusVersionBtn.title = "Update available — click to open release";
        statusVersionBtn.classList.add("has-update");
      } else {
        statusVersionBtn.title = `JJK CC Mod Manager v${appVersion}`;
        statusVersionBtn.classList.remove("has-update");
      }
    } else {
      statusVersionBtn.textContent = "v…";
      statusVersionBtn.title = "App version";
      statusVersionBtn.classList.remove("has-update");
    }
  }
}

/* ── Requirements ───────────────────────────────────────── */

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
    if (req.statusDetail && req.installed !== true) {
      const detail = document.createElement("span");
      detail.className = "req-description";
      detail.textContent = req.statusDetail;
      info.appendChild(detail);
    }

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
      statusBadge.textContent = "Not found";
    } else {
      statusBadge.className = "req-status req-status--unknown";
      statusBadge.textContent = "Unknown";
    }
    if (req.statusDetail) statusBadge.title = req.statusDetail;
    actions.appendChild(statusBadge);

    if (req.installed === false || req.installed === "outdated") {
      if (req.url) {
        const downloadBtn = document.createElement("button");
        downloadBtn.type = "button";
        downloadBtn.className = "btn btn-small btn-ghost req-action-btn";
        downloadBtn.textContent = "Download";
        downloadBtn.addEventListener("click", async () => {
          try {
            await window.modManagerApi.openExternalUrl(req.url);
          } catch { /* ignore */ }
        });
        actions.appendChild(downloadBtn);
      }
      if ((req.zipPath && req.installPath) || req.exePath) {
        const installBtn = document.createElement("button");
        installBtn.type = "button";
        installBtn.className = "req-action-btn--install";
        installBtn.textContent = req.installed === "outdated" ? "Update" : "Install";
        installBtn.addEventListener("click", async () => {
          installBtn.disabled = true;
          installBtn.textContent = "Installing…";
          try {
            const updated = await window.modManagerApi.installRequirement(req.id);
            renderRequirements(updated);
            updateRequirementsBadge(updated);
            toastSuccess("Requirement installed", req.name);
          } catch (error) {
            toastError(`Failed to install ${req.name}`, error.message);
            installBtn.disabled = false;
            installBtn.textContent = "Install";
          }
        });
        actions.appendChild(installBtn);
      }
    }

    li.append(info, actions);
    requirementsListEl.appendChild(li);
  }
}

function updateRequirementsBadge(statuses) {
  lastRequirements = Array.isArray(statuses) ? statuses : [];
  if (!requirementsBadge) {
    updateStatusBar();
    return;
  }
  const hasIssue = lastRequirements.some((s) => s.installed === false || s.installed === "outdated");
  requirementsBadge.hidden = !hasIssue;
  updateStatusBar();
}

async function loadAndRenderRequirements() {
  try {
    const statuses = await window.modManagerApi.checkRequirements();
    renderRequirements(statuses);
    updateRequirementsBadge(statuses);
  } catch { /* ignore */ }
}

function renderAppUpdateStatus(status) {
  if (status && status.currentVersion) appVersion = String(status.currentVersion);
  if (!updateBadge || !openLatestReleaseBtn || !status || status.ok !== true) {
    if (updateBadge) updateBadge.hidden = true;
    latestReleaseUrl = null;
    updateStatusBar();
    return;
  }
  if (!status.hasRelease || status.upToDate) {
    updateBadge.hidden = true;
    latestReleaseUrl = null;
    updateStatusBar();
    return;
  }
  const latest = status.latestVersion || "latest";
  if (updateBadgeText) updateBadgeText.textContent = `Update available (${latest})`;
  updateBadge.hidden = false;
  latestReleaseUrl = status.latestUrl || null;
  updateStatusBar();
}

async function checkAndRenderAppUpdateStatus() {
  try {
    const status = await window.modManagerApi.checkAppUpdate();
    renderAppUpdateStatus(status);
  } catch {
    renderAppUpdateStatus(null);
  }
}

/* ── Setup wizard ───────────────────────────────────────── */

let setupStep = 1;
let setupStatusCache = null;
let setupCleanupChecks = []; // [{ id, checkbox }] — rebuilt on every render

function setSetupWizardOpen(open) {
  if (setupWizardModalEl) setupWizardModalEl.hidden = !open;
}

function openSetupWizard() {
  setupStep = 1;
  setupStatusCache = null;
  setupCleanupChecks = [];
  if (setupCleanupResultEl) setupCleanupResultEl.textContent = "";
  renderSetupStep();
  setSetupWizardOpen(true);
  refreshSetupStatus();
}

/** Any exit marks the wizard seen — it never nags, and Settings can relaunch it. */
async function closeSetupWizardAndComplete(skipped) {
  try {
    await window.modManagerApi.completeSetupWizard?.();
  } catch {
    /* flag write is best-effort — the wizard just closes */
  }
  setSetupWizardOpen(false);
  if (skipped) {
    toastInfo("Setup skipped", "You can rerun the wizard any time from Settings.");
  } else {
    toastSuccess("Setup complete", "Your game is linked and ready for mods.");
  }
}

function renderSetupStep() {
  setupStepPanes.forEach((pane, i) => {
    if (pane) pane.hidden = i !== setupStep - 1;
  });
  const items = setupStepsBar ? Array.from(setupStepsBar.querySelectorAll("li")) : [];
  for (const li of items) {
    const n = Number(li.dataset.setupStep || 0);
    li.classList.toggle("is-active", n === setupStep);
    li.classList.toggle("is-done", n < setupStep);
    const num = li.querySelector(".setup-step-num");
    if (num) num.textContent = n < setupStep ? "✓" : String(n);
  }
  if (setupBackBtn) setupBackBtn.disabled = setupStep === 1;
  if (setupNextBtn) setupNextBtn.textContent = setupStep === 3 ? "Finish ✓" : "Next →";
}

async function refreshSetupStatus() {
  let status = null;
  try {
    status = await window.modManagerApi.getSetupStatus();
  } catch (err) {
    toastError("Setup status failed", err?.message || String(err));
    return;
  }
  setupStatusCache = status;
  renderSetupExe(status);
  renderSetupCleanup(status);
  renderSetupSigpatch(status);
}

function renderSetupExe(status) {
  if (!setupExePathEl) return;
  const exe = status && status.gameExePath;
  if (exe) {
    setupExePathEl.classList.remove("path-line--empty");
    setupExePathEl.textContent = exe;
    setupExePathEl.title = exe;
  } else {
    setupExePathEl.classList.add("path-line--empty");
    setupExePathEl.textContent = "No game selected yet.";
    setupExePathEl.title = "";
  }
}

function updateSetupDeleteButton() {
  if (!setupDeleteSelectedBtn) return;
  setupDeleteSelectedBtn.disabled = !setupCleanupChecks.some((c) => c.checkbox.checked && !c.checkbox.disabled);
}

function renderSetupCleanup(status) {
  if (!setupCleanupListEl) return;
  setupCleanupListEl.innerHTML = "";
  setupCleanupChecks = [];

  if (!status || !status.gameExePath) {
    const li = document.createElement("li");
    li.className = "conflicts-empty";
    li.textContent = "Select your game first (step 1) — then the wizard can look for old files.";
    setupCleanupListEl.appendChild(li);
    updateSetupDeleteButton();
    return;
  }

  const items = (status.cleanup && status.cleanup.items) || [];
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "req-item";

    const label = document.createElement("label");
    label.className = "check-row setup-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(item.found);
    checkbox.disabled = !item.found;
    checkbox.setAttribute("aria-label", `Delete ${item.name}`);
    const ui = document.createElement("span");
    ui.className = "check-ui";
    ui.setAttribute("aria-hidden", "true");
    label.append(checkbox, ui);
    checkbox.addEventListener("change", updateSetupDeleteButton);
    setupCleanupChecks.push({ id: item.id, checkbox });

    const info = document.createElement("div");
    info.className = "req-info";
    const name = document.createElement("span");
    name.className = "req-name";
    name.textContent = item.name;
    info.appendChild(name);
    const desc = document.createElement("span");
    desc.className = "req-description";
    desc.textContent = item.description;
    info.appendChild(desc);
    const existing = (item.paths || []).filter((p) => p.exists).map((p) => p.rel);
    if (existing.length > 0) {
      const found = document.createElement("span");
      found.className = "req-description";
      found.textContent = `Found: ${existing.join(", ")}`;
      info.appendChild(found);
    }

    const actions = document.createElement("div");
    actions.className = "req-actions";
    const badge = document.createElement("span");
    if (item.found) {
      badge.className = "req-status req-status--outdated";
      badge.textContent = "Found";
    } else {
      badge.className = "req-status req-status--ok";
      badge.textContent = "Clean";
    }
    actions.appendChild(badge);

    li.append(label, info, actions);
    setupCleanupListEl.appendChild(li);
  }
  updateSetupDeleteButton();
}

function renderSetupSigpatch(status) {
  const sig = (status && status.sigpatch) || { installed: null, statusDetail: null };
  if (setupSigpatchBoxEl) {
    setupSigpatchBoxEl.innerHTML = "";
    const title = document.createElement("h3");
    title.className = "setting-card-title";
    title.textContent = "UTOC Signature Bypass";
    setupSigpatchBoxEl.appendChild(title);
    const row = document.createElement("div");
    row.className = "req-item setup-sigpatch-row";
    const info = document.createElement("div");
    info.className = "req-info";
    const desc = document.createElement("span");
    desc.className = "req-description";
    desc.textContent = "Required to load modded IoStore (.utoc/.ucas) containers.";
    info.appendChild(desc);
    if (sig.statusDetail && sig.installed !== true) {
      const detail = document.createElement("span");
      detail.className = "req-description";
      detail.textContent = sig.statusDetail;
      info.appendChild(detail);
    }
    const actions = document.createElement("div");
    actions.className = "req-actions";
    const badge = document.createElement("span");
    if (sig.installed === true) {
      badge.className = "req-status req-status--ok";
      badge.textContent = "Installed";
    } else if (sig.installed === false) {
      badge.className = "req-status req-status--missing";
      badge.textContent = "Not found";
    } else {
      badge.className = "req-status req-status--unknown";
      badge.textContent = "Unknown";
    }
    if (sig.statusDetail) badge.title = sig.statusDetail;
    actions.appendChild(badge);
    row.append(info, actions);
    setupSigpatchBoxEl.appendChild(row);
  }
  if (setupInstallSigpatchBtn) {
    if (!status || !status.gameExePath) {
      setupInstallSigpatchBtn.disabled = true;
      setupInstallSigpatchBtn.textContent = "Select your game first";
    } else if (sig.installed === true) {
      setupInstallSigpatchBtn.disabled = false;
      setupInstallSigpatchBtn.textContent = "Reinstall signature bypass";
    } else if (sig.installed === false) {
      setupInstallSigpatchBtn.disabled = false;
      setupInstallSigpatchBtn.textContent = "Install signature bypass";
    } else {
      setupInstallSigpatchBtn.disabled = true;
      setupInstallSigpatchBtn.textContent = "Install signature bypass";
    }
  }
}

setupPickExeBtn?.addEventListener("click", async () => {
  try {
    const result = await window.modManagerApi.changeGameLocation();
    if (!result || result.cancelled) return;
    applyState(result);
    await refreshSetupStatus();
    toastSuccess("Game linked", result.gameLocation || "Game location updated.");
  } catch (err) {
    toastError("Could not link game", err?.message || String(err));
  }
});

setupDeleteSelectedBtn?.addEventListener("click", async () => {
  const ids = setupCleanupChecks
    .filter((c) => c.checkbox.checked && !c.checkbox.disabled)
    .map((c) => c.id);
  if (!ids.length) return;
  const ok = window.confirm(
    `Delete legacy setup files (${ids.join(", ")}) from the game folder?\nThis cannot be undone.`
  );
  if (!ok) return;
  setupDeleteSelectedBtn.disabled = true;
  setupDeleteSelectedBtn.textContent = "Deleting…";
  try {
    const res = await window.modManagerApi.deleteLegacySetup(ids);
    setupStatusCache = { ...(setupStatusCache || {}), cleanup: res.cleanup };
    renderSetupCleanup(setupStatusCache);
    const removed = Array.isArray(res.removed) ? res.removed : [];
    const errors = Array.isArray(res.errors) ? res.errors : [];
    if (setupCleanupResultEl) {
      if (errors.length > 0) {
        setupCleanupResultEl.textContent = `Deleted ${removed.length} path(s), ${errors.length} failed: ${errors.join("; ")}`;
      } else if (removed.length > 0) {
        setupCleanupResultEl.textContent = `Removed: ${removed.join(", ")}`;
      } else {
        setupCleanupResultEl.textContent = "Nothing to remove — already clean.";
      }
    }
    if (errors.length > 0) {
      toastError("Cleanup incomplete", errors.join("\n"));
    } else if (removed.length > 0) {
      toastSuccess("Cleanup done", `Removed ${removed.length} legacy path(s).`);
    }
  } catch (err) {
    toastError("Cleanup failed", err?.message || String(err));
  } finally {
    setupDeleteSelectedBtn.textContent = "Delete selected";
    updateSetupDeleteButton();
  }
});

setupInstallSigpatchBtn?.addEventListener("click", async () => {
  setupInstallSigpatchBtn.disabled = true;
  setupInstallSigpatchBtn.textContent = "Installing…";
  try {
    const updated = await window.modManagerApi.installRequirement("signature-bypass");
    await refreshSetupStatus();
    renderRequirements(updated);
    updateRequirementsBadge(updated);
    toastSuccess("Signature bypass installed", "Modded containers will now load in-game.");
  } catch (err) {
    toastError("Install failed", err?.message || String(err));
  } finally {
    renderSetupSigpatch(setupStatusCache);
  }
});

setupBackBtn?.addEventListener("click", () => {
  if (setupStep > 1) {
    setupStep -= 1;
    renderSetupStep();
  }
});

setupNextBtn?.addEventListener("click", () => {
  if (setupStep < 3) {
    if (setupStep === 1 && !(setupStatusCache && setupStatusCache.gameExePath)) {
      toastError("Choose your game EXE first", "The wizard needs your Jujutsu Kaisen CC.exe before continuing.");
      return;
    }
    setupStep += 1;
    renderSetupStep();
    return;
  }
  closeSetupWizardAndComplete(false);
});

closeSetupWizardBtn?.addEventListener("click", () => closeSetupWizardAndComplete(true));
setupWizardModalEl?.addEventListener("click", (e) => {
  if (e.target === setupWizardModalEl) closeSetupWizardAndComplete(true);
});
runSetupWizardBtn?.addEventListener("click", () => {
  setSettingsOpen(false);
  openSetupWizard();
});

/* ── State ──────────────────────────────────────────────── */

function setBulkBusy(busy) {
  for (const b of [refreshModsBtn, enableAllModsBtn, disableAllModsBtn]) {
    if (b) b.disabled = busy || !currentModsFolder;
  }
  if (enableAllModsBtn && !busy) enableAllModsBtn.disabled = !currentModsFolder || allMods.length === 0;
  if (disableAllModsBtn && !busy) disableAllModsBtn.disabled = !currentModsFolder || allMods.length === 0;
  if (refreshModsBtn && !busy) refreshModsBtn.disabled = !currentModsFolder;
}

function applyState(result) {
  currentModsFolder = result.modsFolder || null;
  currentGameExePath = result.gameLocation || null;
  currentModsFolderOverride = result.modsFolderOverride || null;
  const hasModsRoot = Boolean(currentModsFolder);
  allMods = Array.isArray(result.mods) ? result.mods : [];
  currentConflicts = result.conflicts && typeof result.conflicts === "object" ? result.conflicts : emptyConflicts();
  updateConflictsUI();

  packageAllBtn.disabled = !hasModsRoot || allMods.filter((m) => m.enabled).length === 0;
  if (installModBtn) installModBtn.disabled = !hasModsRoot;
  if (launchGameBtn) launchGameBtn.disabled = !result.gameLocation;
  if (openModsFolderBtn) openModsFolderBtn.disabled = !hasModsRoot;

  if (clearUnpackedAssetsPathBtn) clearUnpackedAssetsPathBtn.disabled = !result.unpackedAssetsPath;
  if (verboseOutputCheckbox && result.verboseOutput !== undefined) {
    verboseOutputCheckbox.checked = Boolean(result.verboseOutput);
  }
  setSettingsPaths(
    result.modsFolder || null,
    result.gameLocation || null,
    result.unpackedAssetsPath || null,
    result.modsFolderOverride || null,
  );

  // Refresh the primary CTA tooltip with the enabled count.
  const enabledCount = allMods.filter((m) => m.enabled).length;
  if (packageAllBtn) {
    packageAllBtn.title = enabledCount
      ? `Merge and install ${enabledCount} enabled mod${enabledCount === 1 ? "" : "s"} into the game`
      : "Enable at least one mod first";
  }

  renderMods();
  setBulkBusy(false);
  lastModsState = { ...result, mods: allMods };
  loadAndRenderRequirements();
  processPendingOpenFiles();
}

async function init() {
  renderSkeletons(5);
  try {
    const [result] = await Promise.all([
      window.modManagerApi.initApp(),
      checkAndRenderAppUpdateStatus(),
    ]);
    if (result && result.error && !result.gameLocation) {
      renderSkeletons(0);
      modListEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "mod-empty";
      li.innerHTML = "";
      const icon = document.createElement("div");
      icon.className = "mod-empty-icon";
      icon.textContent = "🎮";
      const h = document.createElement("h3");
      h.textContent = "Link your game to begin";
      const p = document.createElement("p");
      p.textContent = result.error || "Select your Jujutsu Kaisen CC.exe when prompted.";
      const actions = document.createElement("div");
      actions.className = "mod-empty-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary";
      btn.textContent = "Open Settings";
      btn.addEventListener("click", () => setSettingsOpen(true));
      actions.appendChild(btn);
      li.append(icon, h, p, actions);
      modListEl.appendChild(li);
      setSettingsPaths(null, null, result.unpackedAssetsPath || null, null);
      toastInfo("Welcome", "Select your game executable to link the mod library.");
      lastModsState = result;
      appReady = true;
      pullInitialModFiles();
      if (result && result.setupWizardCompleted === false) openSetupWizard();
      return;
    }
    applyState(result);
    appReady = true;
    pullInitialModFiles();
    if (result && result.setupWizardCompleted === false) openSetupWizard();
  } catch (err) {
    renderEmptyState();
    toastError("Failed to initialise", err?.message || String(err));
    appReady = true;
    pullInitialModFiles();
  }
}

/* ── Events ─────────────────────────────────────────────── */

conflictsBtn?.addEventListener("click", () => openConflictsModal(null));

statusHealthBtn?.addEventListener("click", () => {
  if (statusHealthBtn?.dataset.action === "requirements") setRequirementsModalOpen(true);
  else setSettingsOpen(true);
});
statusOverlapsBtn?.addEventListener("click", () => openConflictsModal(null));
statusHint?.addEventListener("click", () => {
  if ((currentConflicts.total || 0) > 0 && currentModsFolder && currentGameExePath) openConflictsModal(null);
});
statusVersionBtn?.addEventListener("click", async () => {
  if (latestReleaseUrl) {
    try {
      await window.modManagerApi.openExternalUrl(latestReleaseUrl);
    } catch { /* ignore */ }
  } else if (appVersion) {
    toastInfo(`JJK CC Mod Manager v${appVersion}`, "You're up to date.");
  }
});

closeJsonCheckBtn?.addEventListener("click", () => setJsonCheckModalOpen(false));
jsonCheckModalEl?.addEventListener("click", (e) => {
  if (e.target === jsonCheckModalEl) setJsonCheckModalOpen(false);
});

closeConflictsBtn?.addEventListener("click", () => setConflictsModalOpen(false));
conflictsModalEl?.addEventListener("click", (e) => {
  if (e.target === conflictsModalEl) setConflictsModalOpen(false);
});
conflictsShowAllBtn?.addEventListener("click", () => {
  conflictFilterModId = null;
  renderConflictsList();
});

for (const b of conflictTypeButtons) {
  b.addEventListener('click', () => setConflictTypeFilter(b.dataset.conflictType || 'all'));
}

openRequirementsBtn?.addEventListener("click", () => setRequirementsModalOpen(true));

openLatestReleaseBtn?.addEventListener("click", async () => {
  if (!latestReleaseUrl) return;
  try {
    await window.modManagerApi.openExternalUrl(latestReleaseUrl);
  } catch { /* ignore */ }
});

closeRequirementsBtn?.addEventListener("click", () => setRequirementsModalOpen(false));
requirementsModalEl?.addEventListener("click", (e) => {
  if (e.target === requirementsModalEl) setRequirementsModalOpen(false);
});
refreshRequirementsBtn?.addEventListener("click", async () => {
  refreshRequirementsBtn.disabled = true;
  try {
    await loadAndRenderRequirements();
  } finally {
    refreshRequirementsBtn.disabled = false;
  }
});

refreshModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  setBulkBusy(true);
  renderSkeletons(3);
  try {
    const result = await window.modManagerApi.refreshMods();
    applyState(result);
    toastSuccess("Library refreshed", `${(result.mods || []).length} mod${(result.mods || []).length === 1 ? "" : "s"} found.`);
  } catch (err) {
    if (lastModsState) applyState(lastModsState);
    toastError("Refresh failed", err?.message || String(err));
  }
});

enableAllModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  setBulkBusy(true);
  try {
    const result = await window.modManagerApi.enableAllMods();
    applyState(result);
    toastSuccess("All mods enabled", `${(result.mods || []).length} mods will load next time.`);
  } catch (err) {
    if (lastModsState) applyState(lastModsState);
    toastError("Enable-all failed", err?.message || String(err));
  }
});

disableAllModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  setBulkBusy(true);
  try {
    const result = await window.modManagerApi.disableAllMods();
    applyState(result);
    toastInfo("All mods disabled", "Nothing will load until you re-enable a mod.");
  } catch (err) {
    if (lastModsState) applyState(lastModsState);
    toastError("Disable-all failed", err?.message || String(err));
  }
});

openModsFolderBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  try {
    await window.modManagerApi.openModsFolder(currentModsFolder);
  } catch (err) {
    toastError("Could not open mods folder", err?.message || String(err));
  }
});

/* Files opened via OS association (.jjkmod double-click) wait here until ready. */
let appReady = false;
let addModBusy = false;
const pendingOpenFiles = [];

function processPendingOpenFiles() {
  if (!appReady || addModBusy || pendingOpenFiles.length === 0 || !currentModsFolder) return;
  installModFile(pendingOpenFiles.shift());
}

/**
 * Adds a mod to the library — from the file picker (null) or an explicit
 * path (OS file association / drag source). Sequential via addModBusy.
 */
async function installModFile(explicitPath) {
  if (addModBusy) {
    if (explicitPath) pendingOpenFiles.unshift(explicitPath);
    return;
  }
  if (!currentModsFolder) {
    if (explicitPath) pendingOpenFiles.unshift(explicitPath);
    toastError("No mods folder yet", "Link your game in Settings first, then open the mod file again.");
    return;
  }
  addModBusy = true;
  installModBtn.disabled = true;
  try {
    // OS file association (.jjkmod double-click): confirm before unzipping.
    if (explicitPath) {
      let promptInfo = { title: basenameOfPath(explicitPath) };
      try {
        const preview = await window.modManagerApi.previewModFile?.(explicitPath);
        if (preview) {
          promptInfo = {
            title: preview.displayName || preview.title || preview.modFolderName || promptInfo.title,
            version: preview.version || null,
            exists: Boolean(preview.exists),
            existingVersion: preview.existingVersion || null,
            status: preview.status || (preview.exists ? "unknown" : "new"),
          };
        }
      } catch (previewErr) {
        toastError("Could not open mod file", previewErr?.message || String(previewErr));
        return;
      }
      const ok = await confirmInstallMod(promptInfo);
      if (!ok) return;
    }
    const result = explicitPath
      ? await window.modManagerApi.installModFromFile(explicitPath)
      : await window.modManagerApi.installModFromZip();
    if (result.cancelled) return;
    if (result.action === "unchanged") {
      toastInfo(
        "Already up to date",
`"${result.modFolderName}" is already at v${result.incomingVersion || result.existingVersion || "?"}.`,
      );
      return;
    }
    applyState(result);
    if (result.action === "updated") {
      toastSuccess("Mod updated", `"${result.modFolderName}" → v${result.incomingVersion} (was v${result.existingVersion}).`);
    } else {
      toastSuccess("Mod added", `"${result.modFolderName}" (v${result.incomingVersion || "?"}) added to your library.`);
    }
  } catch (error) {
    toastError("Could not add mod", error.message);
  } finally {
    addModBusy = false;
    installModBtn.disabled = !currentModsFolder;
    processPendingOpenFiles();
  }
}

installModBtn?.addEventListener("click", () => installModFile(null));

installConfirmOkBtn?.addEventListener("click", () => resolvePendingInstall(true));
installConfirmCancelBtn?.addEventListener("click", () => resolvePendingInstall(false));
installConfirmModalEl?.addEventListener("click", (e) => {
  if (e.target === installConfirmModalEl) resolvePendingInstall(false);
});

window.modManagerApi.onOpenModFile?.((files) => {
  for (const f of files || []) pendingOpenFiles.push(f);
  processPendingOpenFiles();
});

// Cold-start files (double-clicked to launch the app) arrive via the
// `renderer-ready` handshake — the listener above must exist first.
async function pullInitialModFiles() {
  try {
    const files = await window.modManagerApi.notifyRendererReady?.();
    if (Array.isArray(files)) {
      for (const f of files) pendingOpenFiles.push(f);
    }
  } catch {
    /* main too old or handshake failed — live `open-mod-file` still works */
  }
  processPendingOpenFiles();
}

changePathBtn?.addEventListener("click", async () => {
  const result = await window.modManagerApi.changeGameLocation();
  if (!result.cancelled) {
    applyState(result);
    toastSuccess("Game linked", result.gameLocation || "Game location updated.");
  }
});

openSettingsBtn?.addEventListener("click", () => setSettingsOpen(true));
closeSettingsBtn?.addEventListener("click", () => setSettingsOpen(false));
settingsModalEl?.addEventListener("click", (e) => {
  if (e.target === settingsModalEl) setSettingsOpen(false);
});

setModsFolderOverrideBtn?.addEventListener("click", async () => {
  try {
    const result = await window.modManagerApi.setModsFolderOverride();
    if (!result.cancelled) {
      applyState(result);
      toastSuccess("Mods folder updated", result.modsFolder || "");
    }
  } catch (err) {
    toastError("Could not set mods folder", err?.message || String(err));
  }
});

clearModsFolderOverrideBtn?.addEventListener("click", async () => {
  try {
    const result = await window.modManagerApi.clearModsFolderOverride();
    applyState(result);
    toastInfo("Mods folder reset", "Using the default Content/Mods location.");
  } catch (err) {
    toastError("Reset failed", err?.message || String(err));
  }
});

closePackageModalBtn?.addEventListener("click", () => {
  if (!packageModalCanClose) return;
  setPackageModalOpen(false);
});
packageModalEl?.addEventListener("click", (e) => {
  if (e.target === packageModalEl && packageModalCanClose) setPackageModalOpen(false);
});

window.modManagerApi.onPackageProgress?.((payload) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "progress") {
    setPackageProgress(payload.progress, payload.step || "Packaging");
    return;
  }
  if (payload.type === "log") {
    const prefix = payload.stream ? `[${payload.stream}] ` : "";
    const isError = payload.stream === "stderr" || payload.stream === "error";
    appendPackageLog(`${prefix}${payload.message ?? ""}`, isError);
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

packageAllBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;

  packageAllBtn.disabled = true;
  packageModalCanClose = false;
  if (closePackageModalBtn) closePackageModalBtn.disabled = true;
  if (packageConsoleEl) packageConsoleEl.textContent = "";
  setPackageModalTitle("Install enabled mods");
  setPackageProgress(0, "Starting");
  appendPackageLog("[info] Installing enabled mods into the game…");
  setPackageModalOpen(true);

  try {
    const output = await window.modManagerApi.packageAllMods(currentModsFolder);
    appendPackageLog(`[done] Output: ${output.outputDir}`);
    if (output.gamePaksModsDir) appendPackageLog(`[done] Game folder: ${output.gamePaksModsDir}`);
    lastInstall = { ok: true, count: output && typeof output.count === "number" ? output.count : allMods.filter((m) => m.enabled).length, time: Date.now() };
    updateStatusBar();
    toastSuccess("Mods installed", "Enabled mods were merged and installed into the game. You're ready to play!");
  } catch (error) {
    appendPackageLog(`[error] ${error.message}`);
    lastInstall = { ok: false, count: 0, time: Date.now() };
    updateStatusBar();
    toastError("Install failed", error.message);
  } finally {
    const enabledCount = allMods.filter((m) => m.enabled).length;
    packageAllBtn.disabled = !currentModsFolder || enabledCount === 0;
    packageModalCanClose = true;
    if (closePackageModalBtn) closePackageModalBtn.disabled = false;
  }
});

setUnpackedAssetsPathBtn?.addEventListener("click", async () => {
  const result = await window.modManagerApi.setUnpackedAssetsPath();
  if (!result.cancelled) {
    applyState(result);
    toastSuccess("Unpacked assets path set", result.unpackedAssetsPath || "");
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
  const ok = window.confirm("Reset unpacked assets path? This clears the saved path from settings.");
  if (!ok) return;
  try {
    const result = await window.modManagerApi.clearUnpackedAssetsPath();
    applyState(result);
  } catch (err) {
    toastError("Reset failed", err?.message || String(err));
  }
});

launchGameBtn?.addEventListener("click", async () => {
  launchGameBtn.disabled = true;
  try {
    await window.modManagerApi.launchGame();
    toastInfo("Launching game", "Jujutsu Kaisen Cursed Clash is starting…");
  } catch (error) {
    toastError("Could not launch game", error.message);
  } finally {
    launchGameBtn.disabled = !lastModsState?.gameLocation;
  }
});

/* ── Search / filter / sort ─────────────────────────────── */

modSearchInput?.addEventListener("input", () => {
  searchQuery = modSearchInput.value || "";
  if (clearSearchBtn) clearSearchBtn.hidden = !searchQuery;
  renderMods();
});

clearSearchBtn?.addEventListener("click", () => {
  if (modSearchInput) modSearchInput.value = "";
  searchQuery = "";
  clearSearchBtn.hidden = true;
  modSearchInput?.focus();
  renderMods();
});

for (const b of filterButtons) {
  b.addEventListener("click", () => {
    setFilter(b.dataset.filter || "all");
    renderMods();
  });
}

modSortSelect?.addEventListener("change", () => {
  sortMode = modSortSelect.value || "priority";
  renderMods();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (setupWizardModalEl && !setupWizardModalEl.hidden) {
      closeSetupWizardAndComplete(true);
      return;
    }
    if (installConfirmModalEl && !installConfirmModalEl.hidden) resolvePendingInstall(false);
    else if (conflictsModalEl && !conflictsModalEl.hidden) setConflictsModalOpen(false);
    else if (jsonCheckModalEl && !jsonCheckModalEl.hidden) setJsonCheckModalOpen(false);
    else if (requirementsModalEl && !requirementsModalEl.hidden) setRequirementsModalOpen(false);
    else if (packageModalEl && !packageModalEl.hidden && packageModalCanClose) setPackageModalOpen(false);
    else if (settingsModalEl && !settingsModalEl.hidden) setSettingsOpen(false);
    return;
  }
  // Press "/" to focus search when not typing in a field.
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      e.preventDefault();
      modSearchInput?.focus();
    }
  }
});

init().catch(() => {});
