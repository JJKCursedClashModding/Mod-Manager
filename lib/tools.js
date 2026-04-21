const path = require("path");
const { existsSync } = require("fs");
const { spawn } = require("child_process");
const { TOOLS_DIR } = require("./constants");

function retocPath() {
  return "retoc";
}

function repakPath() {
  const exe = process.platform === "win32" ? "repak.exe" : "repak";
  const bundled = path.join(TOOLS_DIR, exe);
  if (existsSync(bundled)) {
    return bundled;
  }
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

module.exports = { retocPath, repakPath, runCommand };
