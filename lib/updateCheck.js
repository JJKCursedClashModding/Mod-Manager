const https = require("https");

const OWNER = "JJKCursedClashModding";
const REPO = "Mod-Manager";
const RELEASES_LATEST_URL = `/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${OWNER}/${REPO}/releases`;

function normalizeVersion(input) {
  return String(input || "")
    .trim()
    .replace(/^v/i, "");
}

function parseVersion(version) {
  return normalizeVersion(version)
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const av = left[i] ?? 0;
    const bv = right[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/** Whole-request budget (connect + response) for the update check. */
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function fetchLatestRelease(timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = https.request(
      {
        hostname: "api.github.com",
        path: RELEASES_LATEST_URL,
        method: "GET",
        headers: {
          "User-Agent": "JJK-CC-Mod-Manager",
          Accept: "application/vnd.github+json",
        },
        // Socket idle timeout; the overall timer below also covers slow drips.
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) {
            req.destroy(new Error("GitHub release response too large."));
          }
        });
        res.on("error", (error) => finish(reject, error));
        res.on("end", () => {
          if (res.statusCode === 404) {
            finish(resolve, null);
            return;
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            finish(reject, new Error(`GitHub API request failed (${res.statusCode || "unknown"}).`));
            return;
          }
          try {
            finish(resolve, JSON.parse(body));
          } catch {
            finish(reject, new Error("Failed to parse GitHub release response."));
          }
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new Error(`Update check timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    req.on("timeout", () => {
      req.destroy(new Error(`Update check timed out after ${Math.round(timeoutMs / 1000)}s.`));
    });
    req.on("error", (error) => {
      finish(reject, error);
    });
    req.end();
  });
}

async function checkForAppUpdate(currentVersion) {
  const release = await fetchLatestRelease();
  if (!release) {
    return {
      ok: true,
      hasRelease: false,
      upToDate: true,
      currentVersion: normalizeVersion(currentVersion),
      latestVersion: null,
      latestUrl: RELEASES_PAGE_URL,
    };
  }

  const latestVersion = normalizeVersion(release.tag_name || release.name || "");
  const cmp = compareVersions(currentVersion, latestVersion);
  return {
    ok: true,
    hasRelease: Boolean(latestVersion),
    upToDate: cmp >= 0,
    currentVersion: normalizeVersion(currentVersion),
    latestVersion: latestVersion || null,
    latestUrl: release.html_url || RELEASES_PAGE_URL,
  };
}

module.exports = {
  checkForAppUpdate,
};
