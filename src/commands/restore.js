import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { confirm } from "../lib/confirm.js";

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function isInsideRepo(repoRootAbs, targetAbs) {
  const rel = path.relative(repoRootAbs, targetAbs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function movePath(srcAbs, dstAbs) {
  await ensureDir(path.dirname(dstAbs));
  try {
    await fs.rename(srcAbs, dstAbs);
  } catch (err) {
    // Cross-device fallback
    if (err && err.code === "EXDEV") {
      const stat = await fs.lstat(srcAbs);
      if (stat.isDirectory()) {
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

async function listArchives(archiveBaseAbs) {
  if (!fsSync.existsSync(archiveBaseAbs)) return [];
  const entries = await fs.readdir(archiveBaseAbs, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // ISO-ish names sort correctly as strings most of the time
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

async function walkFiles(dirAbs) {
  const out = [];
  const stack = [dirAbs];

  while (stack.length) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true });

    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      } else if (ent.isSymbolicLink()) {
        // Treat symlinks as items too. We will restore the symlink itself.
        out.push(full);
      }
    }
  }

  return out;
}

function resolveArchivePath({ repoRootAbs, from }) {
  const archiveBaseAbs = path.join(repoRootAbs, ".podshift", "archive");

  if (from) {
    // If user gives a full path, use it
    if (path.isAbsolute(from)) return { archiveBaseAbs, archiveAbs: from };

    // If user gives a timestamp folder name, join it
    return { archiveBaseAbs, archiveAbs: path.join(archiveBaseAbs, from) };
  }

  // Default to latest
  return { archiveBaseAbs, archiveAbs: null };
}

export async function restoreCommand(opts) {
  const repoRootAbs = path.resolve(opts.root || ".");
  const from = opts.from || null;
  const dryRun = Boolean(opts.dryRun);
  const yes = Boolean(opts.yes);
  const overwrite = Boolean(opts.overwrite);

  const { archiveBaseAbs, archiveAbs: explicitArchiveAbs } = resolveArchivePath({ repoRootAbs, from });

  let archiveAbs = explicitArchiveAbs;

  if (!archiveAbs) {
    const archives = await listArchives(archiveBaseAbs);
    if (!archives.length) {
      console.log("No archives found.");
      console.log(`Expected: ${archiveBaseAbs}/<timestamp>`);
      process.exit(2);
    }
    archiveAbs = path.join(archiveBaseAbs, archives[0]);
  }

  if (!fsSync.existsSync(archiveAbs)) {
    console.log(`Archive not found: ${archiveAbs}`);
    process.exit(2);
  }

  // Collect restore candidates
  const files = await walkFiles(archiveAbs);

  if (!files.length) {
    console.log(`Archive is empty: ${archiveAbs}`);
    return;
  }

  const actions = [];
  const candidates = [];

  for (const srcAbs of files) {
    const rel = path.relative(archiveAbs, srcAbs);
    const dstAbs = path.join(repoRootAbs, rel);

    // Safety: never restore outside repo root
    if (!isInsideRepo(repoRootAbs, dstAbs)) {
      actions.push({ type: "skip", src: srcAbs, dst: dstAbs, reason: "destination outside repo root" });
      continue;
    }

    candidates.push({ srcAbs, dstAbs, rel });
  }

  console.log("");
  console.log("Podshift restore");
  console.log(`- Repo root: ${repoRootAbs}`);
  console.log(`- Archive: ${archiveAbs}`);
  console.log(`- Overwrite: ${overwrite ? "yes" : "no"}`);
  console.log(`- Dry run: ${dryRun ? "yes" : "no"}`);
  console.log("");

  console.log("Restore candidates:");
  for (const c of candidates) console.log(`- ${c.rel}`);

  console.log("");

  if (!yes && !dryRun) {
    const ok = await confirm("Restore these files from the archive", { defaultYes: false });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  for (const c of candidates) {
    const dstExists = fsSync.existsSync(c.dstAbs);

    if (dstExists && !overwrite) {
      actions.push({ type: "skip", src: c.srcAbs, dst: c.dstAbs, reason: "destination exists" });
      continue;
    }

    if (!dryRun) {
      if (dstExists && overwrite) {
        await fs.rm(c.dstAbs, { recursive: true, force: true });
      }
      await movePath(c.srcAbs, c.dstAbs);
    }

    actions.push({ type: "restore", src: c.srcAbs, dst: c.dstAbs, overwritten: dstExists && overwrite });
  }

  console.log("✅ Restore complete");
  console.log("");

  console.log("Actions:");
  for (const a of actions) {
    if (a.type === "restore") {
      console.log(`- restore: ${a.dst} ${a.overwritten ? "(overwrote existing)" : ""}`.trim());
    } else {
      console.log(`- skip:    ${a.dst} (${a.reason})`);
    }
  }

  console.log("");
  console.log("Tip:");
  console.log(`- List archives: ls -1 ${archiveBaseAbs}`);
}
