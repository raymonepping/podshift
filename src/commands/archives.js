import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

async function listArchives(archiveBaseAbs) {
  if (!fsSync.existsSync(archiveBaseAbs)) return [];
  const entries = await fs.readdir(archiveBaseAbs, { withFileTypes: true });
  return (
    entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // ISO-ish timestamps sort correctly as strings
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  );
}

/**
 * Fast-ish bounded walk that only counts files (does not collect names unless asked).
 */
async function walkFiles(dirAbs, { maxEntries = 5000, collect = false } = {}) {
  const files = collect ? [] : null;
  const stack = [dirAbs];
  let seen = 0;
  let count = 0;

  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (seen++ > maxEntries) {
        return {
          count,
          truncated: true,
          scanned: seen,
          files: collect ? files : undefined,
        };
      }

      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else {
        count += 1;
        if (collect) files.push(full);
      }
    }
  }

  return {
    count,
    truncated: false,
    scanned: seen,
    files: collect ? files : undefined,
  };
}

function resolveArchiveAbs({ archiveBaseAbs, show }) {
  if (!show) return null;
  if (path.isAbsolute(show)) return show;
  return path.join(archiveBaseAbs, show);
}

export async function archivesCommand(opts) {
  const repoRootAbs = path.resolve(opts.root || ".");
  const archiveBaseAbs = path.join(repoRootAbs, ".podshift", "archive");

  const json = Boolean(opts.json);
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 25;

  const archives = await listArchives(archiveBaseAbs);
  const latest = archives[0] || null;

  // New: --latest shortcut
  const latestFlag = Boolean(opts.latest);
  const show = opts.show || (latestFlag ? latest : null);
  const showAbs = resolveArchiveAbs({ archiveBaseAbs, show });

  // SHOW MODE: print contents of a single archive
  if (showAbs) {
    if (!fsSync.existsSync(showAbs)) {
      console.log(`Archive not found: ${showAbs}`);
      process.exit(2);
    }

    const walked = await walkFiles(showAbs, {
      maxEntries: 8000,
      collect: true,
    });
    const relFiles = (walked.files || [])
      .map((f) => path.relative(showAbs, f))
      .sort();

    if (json) {
      console.log(
        JSON.stringify(
          {
            repoRoot: repoRootAbs,
            archiveBase: archiveBaseAbs,
            archive: showAbs,
            fileCount: walked.count,
            truncated: walked.truncated,
            files: relFiles,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log("");
    console.log("Podshift archives");
    console.log(`- Repo root: ${repoRootAbs}`);
    console.log(`- Archive: ${showAbs}`);
    console.log(
      `- Files: ${walked.count}${walked.truncated ? " (truncated)" : ""}`,
    );
    console.log("");
    console.log("Contents:");
    for (const f of relFiles) console.log(`- ${f}`);
    console.log("");
    console.log("Tip:");
    console.log(
      `- Restore: podshift restore --root . --from ${path.basename(showAbs)}`,
    );
    return;
  }

  // LIST MODE: show archives (new: include file counts per archive)
  const shown = archives.slice(0, limit);

  const rows = [];
  for (const name of shown) {
    const abs = path.join(archiveBaseAbs, name);

    // bounded count scan, should be quick in practice
    const walked = await walkFiles(abs, { maxEntries: 3000, collect: false });

    rows.push({
      name,
      abs,
      isLatest: name === latest,
      fileCount: walked.count,
      truncated: walked.truncated,
    });
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          repoRoot: repoRootAbs,
          archiveBase: archiveBaseAbs,
          latest,
          count: archives.length,
          shown: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log("Podshift archives");
  console.log(`- Repo root: ${repoRootAbs}`);
  console.log(`- Archive base: ${archiveBaseAbs}`);
  console.log(`- Total: ${archives.length}`);
  if (latest) console.log(`- Latest: ${latest}`);
  console.log("");

  if (!rows.length) {
    console.log("(no archives found)");
    return;
  }

  console.log("Archives:");
  for (const r of rows) {
    const suffix = [
      r.isLatest ? "latest" : null,
      `${r.fileCount} file${r.fileCount === 1 ? "" : "s"}${r.truncated ? "+" : ""}`,
    ]
      .filter(Boolean)
      .join(", ");

    console.log(`- ${r.name}  (${suffix})`);
  }

  console.log("");
  console.log("Tips:");
  console.log("- Show contents: podshift archives --root . --show <timestamp>");
  console.log("- Show latest: podshift archives --root . --latest");
  console.log("- Restore latest: podshift restore --root .");
  console.log(
    "- Restore specific: podshift restore --root . --from <timestamp>",
  );
}
