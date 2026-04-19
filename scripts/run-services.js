const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const mode = process.argv[2] === "dev" ? "dev" : "start";
const rootDir = path.resolve(__dirname, "..");
const dashboardDir = path.join(rootDir, "dashboard");
const dashboardBuildId = path.join(dashboardDir, "dist", "index.html");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const children = [];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(dashboardDir, ".env"));

function log(message) {
  process.stdout.write(`[runner] ${message}\n`);
}

function spawnProcess(label, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  children.push(child);

  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    log(`${label} exited with ${reason}`);

    if (!shuttingDown) {
      shuttingDown = true;
      for (const activeChild of children) {
        if (!activeChild.killed) {
          activeChild.kill("SIGINT");
        }
      }
      process.exit(code ?? 0);
    }
  });

  return child;
}

let shuttingDown = false;

async function ensureDashboardBuild() {
  if (mode !== "start") return;
  if (fs.existsSync(dashboardBuildId)) return;

  log("Dashboard build not found. Building dashboard before startup...");

  await new Promise((resolve, reject) => {
    const build = spawn(npmCommand, ["run", "build"], {
      cwd: dashboardDir,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    build.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Dashboard build failed with code ${code}`));
    });
  });
}

function attachShutdownHandlers() {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}. Stopping bot and dashboard...`);
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGINT");
      }
    }
    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  attachShutdownHandlers();
  await ensureDashboardBuild();

  if (mode === "dev") {
    log("Starting bot and dashboard in development mode...");
    spawnProcess("bot", npmCommand, ["run", "dev:bot"], rootDir);
    spawnProcess("dashboard", npmCommand, ["run", "dev:dashboard"], rootDir);
    return;
  }

  log("Starting bot and dashboard in production mode...");
  spawnProcess("bot", npmCommand, ["run", "start:bot"], rootDir);
  spawnProcess("dashboard", npmCommand, ["run", "start:dashboard"], rootDir);
}

main().catch((error) => {
  console.error("[runner] Startup failed:", error);
  process.exit(1);
});
