/**
 * Shared async helpers for keeping Electron's main event loop responsive.
 *
 * `async` alone doesn't unblock anything: CPU-bound sync code (zip
 * inflate, JSON parse, usmap/registry serialize) still blocks the loop
 * until it returns. Awaiting this between chunks lets queued IPC
 * (`package-progress`, invoke replies) flush so the UI doesn't look hung.
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Async existence check (non-blocking replacement for `existsSync`).
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function existsAsync(p) {
  if (!p || typeof p !== "string") return false;
  try {
    const fs = require("fs/promises");
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Yields every N iterations of a counted loop.
 * @param {number} count  Current iteration count (1-based).
 * @param {number} every  Yield frequency.
 */
async function yieldEvery(count, every = 20) {
  if (count % every === 0) {
    await yieldToEventLoop();
  }
}

module.exports = { yieldToEventLoop, existsAsync, yieldEvery };
