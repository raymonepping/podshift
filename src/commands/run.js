import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../lib/exec.js";

async function detectComposeRunner({ dryRun }) {
  // Prefer podman-compose if installed (your current setup)
  const tries = [
    { cmd: "podman-compose", args: ["version"] },
    { cmd: "podman", args: ["compose", "version"] },
  ];

  for (const t of tries) {
    try {
      const r = await run(t.cmd, t.args, { stdio: "pipe", dryRun });
      if (r.code === 0)
        return t.cmd === "podman"
          ? { type: "podman", cmd: "podman", baseArgs: ["compose"] }
          : { type: "podman-compose", cmd: "podman-compose", baseArgs: [] };
    } catch {
      // ignore
    }
  }

  throw new Error(
    "No compose runner found. Install podman-compose (brew install podman-compose) or use a Podman version that supports 'podman compose'.",
  );
}

async function ensurePodmanMachineRunning({ dryRun }) {
  if (os.platform() !== "darwin") return;

  const res = await run("podman", ["machine", "start"], {
    dryRun,
    stdio: dryRun ? "inherit" : "pipe",
  });

  if (dryRun) return;

  if (res.code === 0) return;

  const text = `${res.stdout}\n${res.stderr}`.toLowerCase();
  if (text.includes("already running")) return;

  throw new Error(`podman machine start failed:\n${res.stderr || res.stdout}`);
}

export async function runCommand(opts) {
  const file = opts.file || "./podman-compose.yml";
  const projectDir = opts.projectDir || ".";
  const build = Boolean(opts.build);
  const detach = Boolean(opts.detach);
  const dryRun = Boolean(opts.dryRun);

  const fileAbs = path.resolve(projectDir, file);
  if (!fs.existsSync(fileAbs)) {
    throw new Error(`Compose file not found: ${fileAbs}`);
  }

  await ensurePodmanMachineRunning({ dryRun });

  const runner = await detectComposeRunner({ dryRun });

  const args = [
    ...runner.baseArgs,
    "-f",
    fileAbs,
    "up",
    ...(detach ? ["-d"] : []),
    ...(build ? ["--build"] : []),
  ];

  const res = await run(runner.cmd, args, {
    cwd: path.resolve(projectDir),
    dryRun,
  });
  if (res.code !== 0) process.exit(res.code);

  console.log("✅ Podshift run complete");
}
