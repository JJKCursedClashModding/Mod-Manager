/* JJK CC Mod Manager — remote file browser (experiment/remote-host).
 *
 * Provides window.__jjkmmBrowse({ mode, title, startDir, extensions })
 * -> Promise<string|null> : a modal file browser against the HOST filesystem
 * (via server.js browse-drives / browse-list). Used by remote-api.js instead
 * of blind prompt()s. No-op under Electron (preload owns dialogs there).
 *
 * Self-contained: own config resolution (lazy, per-open), own styles.
 */
"use strict";

(function () {
  if (typeof window === "undefined") return;
  if (window.__jjkmmBrowse) return;

  function resolveConfig() {
    const params = new URLSearchParams(window.location.search || "");
    let host = params.get("host") || window.localStorage.getItem("jjkmm.host") || window.location.origin;
    host = host.replace(/\/+$/, "");
    const token = params.get("token") || window.localStorage.getItem("jjkmm.token") || "";
    return { host, token };
  }

  async function api(method, args) {
    const { host, token } = resolveConfig();
    const url = `${host}/api/${method}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Remote-Token"] = token;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ args: args || [] }) });
    } catch (e) {
      throw new Error(`Cannot reach remote host at ${host}.`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body.result;
  }

  function ensureStyle() {
    if (document.getElementById("jjkmm-browse-style")) return;
    const st = document.createElement("style");
    st.id = "jjkmm-browse-style";
    st.textContent = `
      .jjkmm-browse-path { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px;
        background: rgba(0,0,0,.3); border: 1px solid var(--border-soft, #2a3350); border-radius: 7px;
        padding: 7px 10px; word-break: break-all; color: var(--muted, #9aa3c7); margin: 0 0 10px; line-height: 1.45; }
      .jjkmm-browse-bar { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
      .jjkmm-browse-bar select, .jjkmm-browse-bar input[type="search"], .jjkmm-browse-manual input {
        background: #111524; border: 1px solid var(--border, #2a3350); color: var(--text, #e8ebf7);
        border-radius: 7px; padding: 6px 9px; font-size: 12px; }
      .jjkmm-browse-bar select { max-width: 150px; }
      .jjkmm-browse-bar input[type="search"] { flex: 1; min-width: 120px; }
      .jjkmm-browse-list { border: 1px solid var(--border-soft, #2a3350); border-radius: 9px; overflow-y: auto;
        height: 300px; background: rgba(0,0,0,.25); }
      .jjkmm-browse-row { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
        background: transparent; border: 0; border-bottom: 1px solid rgba(255,255,255,.04);
        color: var(--text, #e8ebf7); font-size: 12.5px; padding: 7px 11px; cursor: pointer; }
      .jjkmm-browse-row:hover { background: rgba(109,124,255,.12); }
      .jjkmm-browse-row.is-selected { background: rgba(109,124,255,.22); }
      .jjkmm-browse-row.is-disabled { opacity: .38; cursor: default; }
      .jjkmm-browse-row .ico { width: 18px; text-align: center; flex-shrink: 0; }
      .jjkmm-browse-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .jjkmm-browse-row .sz { color: var(--faint, #6b7394); font-size: 11px; flex-shrink: 0; }
      .jjkmm-browse-empty, .jjkmm-browse-error { padding: 18px; text-align: center; font-size: 12.5px;
        color: var(--muted, #9aa3c7); }
      .jjkmm-browse-error { color: #ff9d9d; white-space: pre-line; }
      .jjkmm-browse-manual { display: flex; gap: 7px; margin-top: 10px; }
      .jjkmm-browse-manual input { flex: 1; min-width: 0; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
      .jjkmm-browse-foot { display: flex; gap: 7px; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap; }
      .jjkmm-browse-hint { font-size: 11.5px; color: var(--faint, #6b7394); margin-top: 8px; }
    `;
    document.head.appendChild(st);
  }

  function fmtSize(n) {
    if (n == null || n === 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }

  /**
   * Open the browser modal.
   * @param {object} opts { mode: "file"|"folder", title, sub, startDir,
   *   extensions: [".exe"] (file mode filter), fileName?: exactname match hint }
   * @returns {Promise<string|null>} host-local path or null when cancelled.
   */
  function browse(opts) {
    opts = opts || {};
    const mode = opts.mode === "file" ? "file" : "folder";
    const extensions = (opts.extensions || []).map((e) => String(e).toLowerCase());
    ensureStyle();

    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      };

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <section class="modal-panel modal-wide" role="dialog" aria-modal="true" aria-label="Browse host files">
          <div class="modal-head">
            <div>
              <h2 class="modal-title"></h2>
              <p class="modal-sub"></p>
            </div>
            <div class="modal-head-actions">
              <button type="button" class="btn btn-small btn-ghost" data-x="close">✕</button>
            </div>
          </div>
          <p class="jjkmm-browse-path" data-x="path">…</p>
          <div class="jjkmm-browse-bar">
            <select data-x="drives" title="Drives"></select>
            <button type="button" class="btn btn-small btn-ghost" data-x="up" title="Up one folder">↑ Up</button>
            <button type="button" class="btn btn-small btn-ghost" data-x="refresh" title="Refresh">⟳</button>
            <input type="search" data-x="filter" placeholder="Filter…" aria-label="Filter entries" />
          </div>
          <div class="jjkmm-browse-list" data-x="list"></div>
          <div class="jjkmm-browse-manual">
            <input data-x="manual" spellcheck="false" placeholder="…or paste/type a host path manually" aria-label="Manual host path" />
          </div>
          <div class="jjkmm-browse-foot">
            <button type="button" class="btn btn-small btn-ghost" data-x="cancel">Cancel</button>
            <button type="button" class="btn btn-small btn-primary" data-x="confirm"></button>
          </div>
          <p class="jjkmm-browse-hint">Browsing the <strong>host PC's</strong> filesystem (where the game is installed).</p>
        </section>`;

      const $ = (k) => overlay.querySelector(`[data-x="${k}"]`);
      overlay.querySelector(".modal-title").textContent = opts.title || (mode === "file" ? "Choose a file" : "Choose a folder");
      overlay.querySelector(".modal-sub").textContent =
        opts.sub || (mode === "file" ? "Double-click a file or select + Confirm" : "Navigate, then confirm the current folder");
      $("confirm").textContent = mode === "file" ? "Choose file" : "Select this folder";

      let currentDir = null;
      let allEntries = [];
      let selectedFile = null;
      let lastGoodDir = null;

      function matchesFilter(f) {
        if (!extensions.length) return true;
        return extensions.some((ext) => f.toLowerCase().endsWith(ext));
      }

      function render() {
        $("path").textContent = currentDir || "…";
        $("manual").placeholder = currentDir || "…or paste/type a host path manually";
        const q = ($("filter").value || "").toLowerCase();
        const list = $("list");
        list.innerHTML = "";
        const rows = allEntries.filter((e) => !q || e.name.toLowerCase().includes(q));
        if (!rows.length) {
          const d = document.createElement("div");
          d.className = "jjkmm-browse-empty";
          d.textContent = "Empty folder";
          list.appendChild(d);
        }
        for (const e of rows) {
          const b = document.createElement("button");
          b.type = "button";
          const usable = e.isDir || mode === "folder" ? true : matchesFilter(e.name);
          b.className = "jjkmm-browse-row" + (!usable && !e.isDir ? " is-disabled" : "") +
            (selectedFile && selectedFile.path === e.path ? " is-selected" : "");
          b.innerHTML = `<span class="ico">${e.isDir ? "📁" : "📄"}</span>` +
            `<span class="nm"></span><span class="sz">${e.isDir ? "" : fmtSize(e.size)}</span>`;
          b.querySelector(".nm").textContent = e.name;
          b.title = e.path;
          b.onclick = () => {
            if (e.isDir) {
              selectedFile = null;
              load(e.path);
            } else if (mode === "file" && matchesFilter(e.name)) {
              selectedFile = e;
              render();
            }
          };
          b.ondblclick = () => {
            if (e.isDir) {
              selectedFile = null;
              load(e.path);
            } else if (mode === "file" && matchesFilter(e.name)) {
              finish(e.path);
            }
          };
          list.appendChild(b);
        }
        updateConfirm();
      }

      function updateConfirm() {
        if (mode === "folder") {
          $("confirm").disabled = !currentDir;
        } else {
          $("confirm").disabled = !selectedFile;
        }
      }

      function showError(msg) {
        const list = $("list");
        list.innerHTML = "";
        const d = document.createElement("div");
        d.className = "jjkmm-browse-error";
        d.textContent = msg;
        list.appendChild(d);
      }

      async function load(dir) {
        $("path").textContent = "Loading…";
        try {
          const r = await api("browse-list", [dir]);
          currentDir = r.dir;
          lastGoodDir = r.dir;
          allEntries = r.entries;
          if (selectedFile && !selectedFile.path.startsWith(r.dir)) selectedFile = null;
          overlay.dataset.parent = r.parent || "";
          $("up").disabled = !r.parent;
          render();
        } catch (e) {
          showError(e.message);
          if (lastGoodDir && dir !== lastGoodDir) {
            // stay where we were
          }
        }
      }

      // Drives
      api("browse-drives", [])
        .then((r) => {
          const sel = $("drives");
          sel.innerHTML = "";
          for (const d of r.drives || []) {
            const o = document.createElement("option");
            o.value = d.path;
            o.textContent = d.label || d.path;
            sel.appendChild(o);
          }
          sel.onchange = () => {
            selectedFile = null;
            load(sel.value);
          };
          let start = opts.startDir || null;
          if (!start && opts.rememberKey) start = window.localStorage.getItem(opts.rememberKey) || null;
          if (!start) start = (r.drives[0] && r.drives[0].path) || r.home || "/";
          // Preselect nearest drive in the dropdown
          const low = start.toLowerCase();
          let best = null;
          for (const o of sel.options) {
            if (low.startsWith(o.value.toLowerCase())) best = o.value;
          }
          if (best) sel.value = best;
          load(start);
        })
        .catch((e) => showError(e.message));

      $("up").onclick = () => {
        if (overlay.dataset.parent) {
          selectedFile = null;
          load(overlay.dataset.parent);
        }
      };
      $("refresh").onclick = () => load(currentDir);
      $("filter").oninput = render;
      $("close").onclick = () => finish(null);
      $("cancel").onclick = () => finish(null);
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) finish(null);
      });
      $("confirm").onclick = () => {
        const manual = ($("manual").value || "").trim();
        if (manual) {
          finish(manual);
          return;
        }
        if (mode === "folder" && currentDir) finish(currentDir);
        else if (mode === "file" && selectedFile) finish(selectedFile.path);
      };
      function onKey(e) {
        if (e.key === "Escape") finish(null);
        if (e.key === "Enter" && document.activeElement === $("manual")) $("confirm").click();
      }
      document.addEventListener("keydown", onKey, true);

      document.body.appendChild(overlay);
      const cleanup = () => {
        if (!done && !document.body.contains(overlay)) {
          done = true;
          document.removeEventListener("keydown", onKey, true);
          resolve(null);
        }
      };
      // If something else removes the overlay, treat as cancel.
      new MutationObserver(cleanup).observe(document.body, { childList: true });
    });
  }

  window.__jjkmmBrowse = browse;
})();
