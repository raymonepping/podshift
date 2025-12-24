// src/commands/publish.js
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { ensureDir, writeJson } from "../lib/fs.js";

/**
 * Run a command and capture stdout/stderr.
 * Throws on non-zero exit code.
 */
function runCmd(cmd, args, { cwd, env, dryRun, quiet } = {}) {
  const pretty = [cmd, ...args].join(" ");

  if (dryRun) {
    if (!quiet) process.stdout.write(`$ ${pretty}\n`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) child.stdout.on("data", (d) => (stdout += d.toString()));
    if (child.stderr) child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });

      const err = new Error(`Command failed (${code}): ${pretty}`);
      err.stdout = stdout;
      err.stderr = stderr;
      err.code = code;
      return reject(err);
    });
  });
}

function parseCsvList(v, fallback) {
  if (!v) return fallback;
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeImageAndTag(image, tag) {
  const raw = String(image || "").trim();
  if (!raw) throw new Error("--image is required");

  // If user provides image with a tag (repo:tag), allow override with --tag.
  const lastColon = raw.lastIndexOf(":");
  const hasTag = lastColon > raw.lastIndexOf("/");

  if (hasTag) {
    const repo = raw.slice(0, lastColon);
    const imgTag = raw.slice(lastColon + 1);
    return { image: repo, tag: tag ? String(tag) : imgTag };
  }

  return { image: raw, tag: tag ? String(tag) : "latest" };
}

function platformSuffix(platform) {
  // linux/amd64 -> amd64, linux/arm64 -> arm64
  const p = String(platform).trim();
  const parts = p.split("/");
  const suffix = parts.length > 1 ? parts[1] : p;
  return suffix.replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

function pickBuildFile(repoRoot, contextAbs, explicitFile) {
  if (explicitFile) return path.resolve(repoRoot, explicitFile);

  // Prefer build file inside the context directory, then repo root.
  const candidates = [
    path.join(contextAbs, "Containerfile"),
    path.join(contextAbs, "Dockerfile"),
    path.join(repoRoot, "Containerfile"),
    path.join(repoRoot, "Dockerfile"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

async function isManifestLike(ref, { dryRun } = {}) {
  try {
    if (dryRun) return false;
    await runCmd("podman", ["manifest", "inspect", ref], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `ref` is not already claimed by:
 * - a manifest list
 * - a normal image tag
 *
 * Without this, `podman manifest create ref` can fail with:
 * "name already in use"
 *
 * Also avoids noisy "image is not a manifest list" output by only
 * touching manifest commands when inspect succeeds.
 */
async function freeRef(ref, { dryRun, quiet } = {}) {
  // If it is a manifest list (or manifest), remove it first
  if (await isManifestLike(ref, { dryRun })) {
    try {
      await runCmd("podman", ["manifest", "rm", ref], { dryRun, quiet: true });
    } catch {
      // ignore
    }
  }

  // Then remove any image tag that uses the same ref
  try {
    await runCmd("podman", ["image", "rm", "-f", ref], { dryRun, quiet: true });
  } catch {
    // ignore
  }

  // Optional, only in dry-run, keep it readable
  if (dryRun && !quiet) process.stdout.write(`# would free ref: ${ref}\n`);
}

export async function publishCommand(opts) {
  const repoRoot = path.resolve(opts.root || ".");
  const outDir = path.resolve(repoRoot, opts.out || "./output/podshift");

  const dryRun = Boolean(opts.dryRun);
  const quiet = Boolean(opts.quiet);

  const { image, tag } = normalizeImageAndTag(opts.image, opts.tag);

  const context = path.resolve(repoRoot, opts.context || ".");
  const file = pickBuildFile(repoRoot, context, opts.file);

  const platforms = parseCsvList(opts.platforms || opts.platform, [
    "linux/amd64",
    "linux/arm64",
  ]);
  const push = Boolean(opts.push);

  await ensureDir(outDir);

  // Basic preflight
  await runCmd("podman", ["--version"], { dryRun, quiet });

  if (!file) {
    throw new Error(
      `No Dockerfile or Containerfile found (checked context and repo root).\n` +
        `- context: ${context}\n` +
        `- repo root: ${repoRoot}\n` +
        `Fix: run "podshift restore --root ." (if you archived it), or pass --file <path>.`,
    );
  }

  const manifestRef = `${image}:${tag}`;
  const plan = {
    image,
    tag,
    ref: manifestRef,
    platforms,
    context,
    file,
    push,
    strategy: null,
    commands: [],
    primaryError: null,
  };

  const record = (cmd, args) => plan.commands.push({ cmd, args });

  const multiPlatform = platforms.length > 1;

  try {
    if (multiPlatform) {
      plan.strategy = "podman-build-manifest";

      // Important: make sure ref is not already claimed by an image tag
      await freeRef(manifestRef, { dryRun, quiet });

      // Preferred flow: build multi-arch directly into a manifest list
      const args = [
        "build",
        "--platform",
        platforms.join(","),
        "--manifest",
        manifestRef,
        "-f",
        file,
        context,
      ];

      record("podman", args);
      await runCmd("podman", args, { dryRun, quiet });

      if (push) {
        const dest = `docker://${manifestRef}`;
        const pushArgs = ["manifest", "push", "--all", manifestRef, dest];
        record("podman", pushArgs);
        await runCmd("podman", pushArgs, { dryRun, quiet });
      }
    } else {
      plan.strategy = "podman-build-single";

      // In single-arch, a normal tag is fine
      // But we still free it to keep reruns boring
      await freeRef(manifestRef, { dryRun, quiet });

      const args = [
        "build",
        "--platform",
        platforms[0],
        "-t",
        manifestRef,
        "-f",
        file,
        context,
      ];
      record("podman", args);
      await runCmd("podman", args, { dryRun, quiet });

      if (push) {
        const dest = `docker://${manifestRef}`;
        const pushArgs = ["push", manifestRef, dest];
        record("podman", pushArgs);
        await runCmd("podman", pushArgs, { dryRun, quiet });
      }
    }
  } catch (e) {
    // Preserve the original error for receipts
    plan.primaryError = {
      message: String(e?.message || e),
      code: e?.code,
      stdout: e?.stdout,
      stderr: e?.stderr,
    };

    // Fallback: build per-arch tags, then create + push a manifest
    plan.strategy = "fallback-per-arch-manifest";

    if (!quiet) {
      process.stdout.write(
        "\nPrimary build strategy failed, falling back to per-arch manifest build.\n",
      );
    }

    const perArchImages = [];

    for (const platform of platforms) {
      const suffix = platformSuffix(platform);
      const archRef = `${image}:${tag}-${suffix}`;
      perArchImages.push({ platform, ref: archRef });

      // Keep fallback reruns clean too
      await freeRef(archRef, { dryRun, quiet });

      const args = [
        "build",
        "--platform",
        platform,
        "-t",
        archRef,
        "-f",
        file,
        context,
      ];
      record("podman", args);
      await runCmd("podman", args, { dryRun, quiet });
    }

    // Make sure the manifest ref is not claimed by a normal image tag
    await freeRef(manifestRef, { dryRun, quiet });

    record("podman", ["manifest", "create", manifestRef]);
    await runCmd("podman", ["manifest", "create", manifestRef], {
      dryRun,
      quiet,
    });

    for (const x of perArchImages) {
      const args = ["manifest", "add", manifestRef, x.ref];
      record("podman", args);
      await runCmd("podman", args, { dryRun, quiet });
    }

    if (push) {
      const dest = `docker://${manifestRef}`;
      const args = ["manifest", "push", "--all", manifestRef, dest];
      record("podman", args);
      await runCmd("podman", args, { dryRun, quiet });
    }
  }

  await writeJson(path.join(outDir, "publish.json"), plan);

  if (!quiet) {
    process.stdout.write("\nPublish summary:\n");
    process.stdout.write(`- Ref: ${manifestRef}\n`);
    process.stdout.write(`- Platforms: ${platforms.join(", ")}\n`);
    process.stdout.write(`- Strategy: ${plan.strategy}\n`);
    process.stdout.write(`- Push: ${push ? "yes" : "no"}\n`);
    process.stdout.write(`- Build file: ${file}\n`);
    process.stdout.write(`- Context: ${context}\n`);
    process.stdout.write(`- Artifact: ${path.join(outDir, "publish.json")}\n`);
  }

  if (push && !dryRun && !quiet) {
    process.stdout.write(
      "\nTip: if push failed with auth, run: podman login docker.io\n",
    );
  }
}
