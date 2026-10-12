const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const { TOOLS_DIR } = require("./constants");
const { existsAsync } = require("./asyncUtils");

function retocPath() {
  // Sync fast-path: single cheap probe at spawn time (already async context
  // yields around it in callers). Kept sync so existing call sites stay simple.
  const exe = process.platform === "win32" ? "retoc.exe" : "retoc";
  return path.join(TOOLS_DIR, exe);
}

function repakPath() {
  const exe = process.platform === "win32" ? "repak.exe" : "repak";
  return path.join(TOOLS_DIR, exe);
}

async function retocPathAsync() {
  const bundled = retocPath();
  if (await existsAsync(bundled)) return bundled;
  throw new Error(`Missing retoc executable at ${bundled}`);
}

async function repakPathAsync() {
  const bundled = repakPath();
  if (await existsAsync(bundled)) return bundled;
  throw new Error(`Missing repak executable at ${bundled}`);
}

async function runCommand(command, args, cwd, options = null) {
  const reporter = options?.reporter;
  if (reporter) {
    reporter({ type: "log", stream: "cmd", message: `$ ${command} ${args.join(" ")}` });
  }
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutCarry = "";
    let stderrCarry = "";

    proc.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      const parts = `${stdoutCarry}${text}`.split(/\r?\n/);
      stdoutCarry = parts.pop() ?? "";
      for (const line of parts) {
        if (!line) continue;
        reporter?.({ type: "log", stream: "stdout", message: line });
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      const parts = `${stderrCarry}${text}`.split(/\r?\n/);
      stderrCarry = parts.pop() ?? "";
      for (const line of parts) {
        if (!line) continue;
        reporter?.({ type: "log", stream: "stderr", message: line });
      }
    });

    proc.on("error", (error) => {
      if (reporter) {
        reporter({ type: "log", stream: "error", message: String(error.message || error) });
      }
      reject(error);
    });

    proc.on("close", (code) => {
      if (stdoutCarry) reporter?.({ type: "log", stream: "stdout", message: stdoutCarry });
      if (stderrCarry) reporter?.({ type: "log", stream: "stderr", message: stderrCarry });
      if (code !== 0) {
        const out = (stderr || stdout || "").trim();
        reject(new Error(`${command} failed (${code ?? "null"}): ${out}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { retocPath, repakPath, retocPathAsync, repakPathAsync, runCommand };
