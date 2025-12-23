import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { confirm } from "../lib/confirm.js";
import { loadCompose } from "../lib/compose.js";
import { resolveDockerfileFromBuild } from "../lib/dockerfile.js";

function nowStamp() {
  // 2025-12-23T17-45-10Z
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isInsideRepo(repoRootAbs, targetAbs) {
  const rel = path.relative(repoRootAbs, targetAbs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function movePath(srcAbs, dstAbs) {
  await ensureDir(path.dirname(dstAbs));
  try {
    await fs.rename(srcAbs, dstAbs);
    return;
  } catch (err) {
    // Cross-device move fallback
    if (err && err.code === "EXDEV") {
      const stat = await fs.lstat(srcAbs);
      if (stat.isDirectory()) {
        // For directories, copy recursively then remove.
        await fs.cp(srcAbs, dstAbs, { recursive: true });
        await fs.rm(srcAbs, { recursive: true, force: true });
        return;
      }
      await fs.copyFile(srcAbs, dstAbs);
      await fs.unlink(srcAbs);
      return;
    }
    throw err;
  }
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function resolveMaybeRelativeTo(repoRootAbs, p) {
  return path.isAbsolute(p) ? p : path.resolve(repoRootAbs, p);
}

function detectDockerArtifactsFromCompose(
  repoRootAbs,
  composePathAbs,
  composeObj,
) {
  const dockerArtifacts = new Set();

  // The compose file itself is a docker artifact.
  dockerArtifacts.add(composePathAbs);

  // Common neighbor files
  const composeDir = path.dirname(composePathAbs);
  dockerArtifacts.add(path.join(composeDir, "docker-compose.override.yml"));

  // Root ignore files (common)
  dockerArtifacts.add(path.join(repoRootAbs, ".dockerignore"));

  // Per-service Dockerfile + optional per-service .dockerignore
  const services = composeObj?.services || {};
  for (const [name, svc] of Object.entries(services)) {
    if (!svc?.build) continue;

    const dfAbs = resolveDockerfileFromBuild(repoRootAbs, name, svc.build);
    if (dfAbs) dockerArtifacts.add(path.resolve(dfAbs));

    const buildContextAbs =
      typeof svc.build === "string"
        ? path.resolve(repoRootAbs, svc.build)
        : svc.build?.context
          ? path.resolve(repoRootAbs, svc.build.context)
          : null;

    if (buildContextAbs) {
      dockerArtifacts.add(path.join(buildContextAbs, ".dockerignore"));

      // Some repos keep Dockerfile next to compose root as well.
      // Only add if it exists, to avoid noise.
      dockerArtifacts.add(path.join(buildContextAbs, "Dockerfile"));
    }
  }

  // Sometimes a root-level Dockerfile exists
  dockerArtifacts.add(path.join(repoRootAbs, "Dockerfile"));

  return [...dockerArtifacts];
}

function detectPodmanArtifacts(repoRootAbs) {
  return [
    path.join(repoRootAbs, "podman-compose.yml"),
    path.join(repoRootAbs, "MIGRATION.md"),
    path.join(repoRootAbs, "output", "podshift", "migrate.json"),
  ];
}

export async function cleanCommand(opts) {
  const repoRootAbs = path.resolve(opts.root || ".");
  const composePathAbs = resolveMaybeRelativeTo(
    repoRootAbs,
    opts.compose || "./docker-compose.yml",
  );

  const yes = Boolean(opts.yes);
  const dryRun = Boolean(opts.dryRun);
  const doDelete = Boolean(opts.delete);

  // Load compose if possible. If not, still let the user clean the explicit compose file.
  let composeObj = null;
  try {
    composeObj = await loadCompose(composePathAbs);
  } catch {
    // compose parsing failure is not fatal for clean
  }

  const dockerArtifacts = composeObj
    ? detectDockerArtifactsFromCompose(repoRootAbs, composePathAbs, composeObj)
    : [
        composePathAbs,
        path.join(repoRootAbs, ".dockerignore"),
        path.join(repoRootAbs, "Dockerfile"),
      ];

  const podmanArtifacts = detectPodmanArtifacts(repoRootAbs);

  const existingDocker = dockerArtifacts
    .map((p) => path.resolve(p))
    .filter((p) => isInsideRepo(repoRootAbs, p))
    .filter((p) => fsSync.existsSync(p));

  const missingDocker = dockerArtifacts
    .map((p) => path.resolve(p))
    .filter((p) => isInsideRepo(repoRootAbs, p))
    .filter((p) => !fsSync.existsSync(p));

  const existingPodman = podmanArtifacts
    .map((p) => path.resolve(p))
    .filter((p) => fsSync.existsSync(p));

  // Safety checks: only allow cleaning if migration artifacts exist, unless forced.
  if (!existingPodman.length) {
    console.log(
      "⚠️  No Podman migration artifacts were found (podman-compose.yml, MIGRATION.md, migrate.json).",
    );
    console.log("    Refusing to clean Docker artifacts by default.");
    console.log("    Run: podshift migrate ... first, then podshift clean");
    process.exit(2);
  }

  if (!existingDocker.length) {
    console.log("No Docker artifacts found to clean.");
    return;
  }

  const stamp = nowStamp();
  const archiveRoot = path.join(repoRootAbs, ".podshift", "archive", stamp);

  console.log("");
  console.log("Podshift clean");
  console.log(`- Repo root: ${repoRootAbs}`);
  console.log(`- Mode: ${doDelete ? "delete" : "archive"}`);
  console.log(`- Dry run: ${dryRun ? "yes" : "no"}`);
  console.log("");

  console.log("Docker artifacts to clean:");
  for (const p of existingDocker) console.log(`- ${p}`);

  if (missingDocker.length) {
    console.log("");
    console.log("Not present (ignored):");
    for (const p of missingDocker) console.log(`- ${p}`);
  }

  console.log("");

  if (!yes && !dryRun) {
    const ok = await confirm(
      doDelete ? "Delete these Docker files" : "Archive these Docker files",
      {
        defaultYes: false,
      },
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const actions = [];

  for (const srcAbs of existingDocker) {
    if (!isInsideRepo(repoRootAbs, srcAbs)) {
      actions.push({ type: "skip", src: srcAbs, reason: "outside repo root" });
      continue;
    }

    if (doDelete) {
      actions.push({ type: "delete", src: srcAbs });
      if (!dryRun) {
        await fs.rm(srcAbs, { recursive: true, force: true });
      }
    } else {
      const rel = path.relative(repoRootAbs, srcAbs);
      const dstAbs = path.join(archiveRoot, rel);
      actions.push({ type: "archive", src: srcAbs, dst: dstAbs });

      if (!dryRun) {
        await movePath(srcAbs, dstAbs);
      }
    }
  }

  console.log("✅ Clean complete");
  console.log("");

  if (!doDelete) {
    console.log(`Archive location: ${archiveRoot}`);
  }

  console.log("");
  console.log("Actions:");
  for (const a of actions) {
    if (a.type === "archive") console.log(`- archive: ${a.src} -> ${a.dst}`);
    else if (a.type === "delete") console.log(`- delete:  ${a.src}`);
    else console.log(`- skip:    ${a.src} (${a.reason})`);
  }
}
