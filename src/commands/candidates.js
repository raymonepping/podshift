// src/commands/candidates.js
import fs from "node:fs";
import path from "node:path";

import { loadIgnoreRulesWithMeta, shouldIgnore } from "../lib/ignore.js";

function rel(rootAbs, absPath) {
  return path.relative(rootAbs, absPath).replace(/\\/g, "/");
}

function isComposeFile(name) {
  // Match:
  // docker-compose.yml
  // docker-compose.override.yml
  // docker-compose.test.override.yml
  // Docker-compose.yml (case-insensitive)
  // compose.yml, compose.dev.yml
  return (
    /^docker-compose(\..+)?\.(yml|yaml)$/i.test(name) ||
    /^compose(\..+)?\.(yml|yaml)$/i.test(name)
  );
}

function isDockerfile(name) {
  return name === "Dockerfile" || name.startsWith("Dockerfile.");
}

function readFileBounded(abs, maxBytes) {
  const fd = fs.openSync(abs, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function computeHintsFromComposeText(text) {
  const t = text || "";
  return {
    parseFailed: false,
    hasHostDockerInternal: /host\.docker\.internal/i.test(t),
    hasDockerSock: /\/var\/run\/docker\.sock/i.test(t),
    hasPrivileged:
      /(privileged:\s*true|pid:\s*host|ipc:\s*host|network_mode:\s*host)/i.test(
        t,
      ),
  };
}

function scanTree(rootAbs, opts) {
  const extraIgnores = Array.isArray(opts.ignore)
    ? opts.ignore
    : opts.ignore
      ? [opts.ignore]
      : [];

  const { rules, meta: ignoreMeta } = loadIgnoreRulesWithMeta(
    rootAbs,
    extraIgnores,
    {
      ignoreFile: opts.ignoreFile,
      useDefaults: opts.defaultIgnore !== false,
    },
  );

  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 20;
  const maxEntries = Number.isFinite(opts.maxEntries)
    ? opts.maxEntries
    : 250000;

  const stack = [{ dir: rootAbs, depth: 0 }];
  const composeFiles = [];
  const dockerfiles = [];

  let scanned = 0;
  let ignored = 0;

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      scanned++;
      if (scanned > maxEntries) {
        return {
          composeFiles,
          dockerfiles,
          scannedEntries: scanned,
          ignoredEntries: ignored,
          ignoreMeta,
          truncated: true,
        };
      }

      const abs = path.join(dir, ent.name);
      const r = rel(rootAbs, abs);

      if (ent.isDirectory()) {
        if (shouldIgnore(r + "/", rules)) {
          ignored++;
          continue;
        }
        stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }

      if (!ent.isFile()) continue;

      if (shouldIgnore(r, rules)) {
        ignored++;
        continue;
      }

      if (isComposeFile(ent.name)) composeFiles.push(abs);
      if (isDockerfile(ent.name)) dockerfiles.push(abs);
    }
  }

  return {
    composeFiles,
    dockerfiles,
    scannedEntries: scanned,
    ignoredEntries: ignored,
    ignoreMeta,
    truncated: false,
  };
}

function groupComposeProjects(rootAbs, composeFilesAbs) {
  const byDir = new Map();
  for (const f of composeFilesAbs) {
    const dirAbs = path.dirname(f);
    const arr = byDir.get(dirAbs) || [];
    arr.push(f);
    byDir.set(dirAbs, arr);
  }

  const projects = Array.from(byDir.entries()).map(([dirAbs, files]) => {
    const name = path.basename(dirAbs);
    const composeFiles = files
      .map((abs) => ({ abs, rel: rel(rootAbs, abs) }))
      .sort((a, b) => a.rel.localeCompare(b.rel));

    return {
      name,
      projectDir: dirAbs,
      composeFiles,
      dockerfiles: [],
      hints: null,
    };
  });

  // Deterministic ordering, name-first but stable if names collide
  projects.sort((a, b) =>
    a.name === b.name
      ? a.projectDir.localeCompare(b.projectDir)
      : a.name.localeCompare(b.name),
  );
  return projects;
}

/**
 * Default behavior:
 * If a directory is already a "project" (has compose),
 * do not list nested compose projects unless explicitly requested.
 */
function collapseChildProjects(projects, includeChildProjects) {
  if (includeChildProjects) return projects;

  const sep = path.sep;
  const byDirAsc = [...projects].sort(
    (a, b) => a.projectDir.length - b.projectDir.length,
  );

  const kept = [];
  for (const p of byDirAsc) {
    const isChild = kept.some(
      (k) =>
        p.projectDir === k.projectDir ||
        p.projectDir.startsWith(k.projectDir + sep),
    );
    if (!isChild) kept.push(p);
  }

  kept.sort((a, b) =>
    a.name === b.name
      ? a.projectDir.localeCompare(b.projectDir)
      : a.name.localeCompare(b.name),
  );
  return kept;
}

function attachDockerfilesToProjects(
  rootAbs,
  projects,
  dockerfilesAbs,
  includeChildren,
) {
  if (!includeChildren) return;

  const projectDirs = projects
    .map((p) => p.projectDir)
    .sort((a, b) => b.length - a.length);

  for (const df of dockerfilesAbs) {
    const dfDir = path.dirname(df);
    const owner = projectDirs.find(
      (pd) => dfDir === pd || dfDir.startsWith(pd + path.sep),
    );
    if (!owner) continue;

    const p = projects.find((x) => x.projectDir === owner);
    if (!p) continue;

    p.dockerfiles.push({ abs: df, rel: rel(rootAbs, df) });
  }

  for (const p of projects) {
    p.dockerfiles.sort((a, b) => a.rel.localeCompare(b.rel));
  }
}

/**
 * One canonical ignore summary formatter:
 * - show defaults yes/no
 * - show only loaded ignore file(s)
 * - hide missing ones
 * - tolerate older meta shapes
 */
function formatIgnoreSummary(ignoreMeta) {
  if (!ignoreMeta) return null;

  // defaults enabled
  const defaultsEnabled =
    typeof ignoreMeta.defaults?.enabled === "boolean"
      ? ignoreMeta.defaults.enabled
      : Boolean(ignoreMeta.useDefaults ?? ignoreMeta.defaultsUsed ?? true);

  const parts = [`defaults=${defaultsEnabled ? "yes" : "no"}`];

  // Preferred: ignoreMeta.effective.loadedFiles
  let loaded = Array.isArray(ignoreMeta.effective?.loadedFiles)
    ? ignoreMeta.effective.loadedFiles
    : [];

  // Fallback: files.root/home/custom used flags
  if (!loaded.length && ignoreMeta.files) {
    const root = ignoreMeta.files.root;
    const home = ignoreMeta.files.home;
    const custom = ignoreMeta.files.custom;

    if (custom?.used && custom?.path) loaded.push(custom.path);
    if (root?.used && root?.path) loaded.push(root.path);
    if (home?.used && home?.path && !home?.skippedBecauseSameAsRoot)
      loaded.push(home.path);
  }

  // Older flat keys fallback
  if (!loaded.length) {
    if (ignoreMeta.ignoreFileLoaded && ignoreMeta.ignoreFile)
      loaded.push(ignoreMeta.ignoreFile);
    if (ignoreMeta.customLoaded && ignoreMeta.customIgnore)
      loaded.push(ignoreMeta.customIgnore);
    if (ignoreMeta.rootLoaded && ignoreMeta.rootIgnore)
      loaded.push(ignoreMeta.rootIgnore);
    if (ignoreMeta.homeLoaded && ignoreMeta.homeIgnore)
      loaded.push(ignoreMeta.homeIgnore);
  }

  // De-dupe while preserving order
  if (loaded.length) {
    const seen = new Set();
    loaded = loaded.filter((p) => {
      const k = String(p);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    parts.push(`ignoreFile=${loaded.join(", ")}`);
  }

  return parts.join(" | ");
}

function renderLegacyText(result, opts) {
  const lines = [];
  lines.push("Podshift candidates");
  lines.push(`- Root: ${result.root}`);
  lines.push(`- Scanned entries: ${result.scannedEntries}`);
  lines.push(`- Ignored entries: ${result.ignoredEntries}`);
  lines.push(`- Projects found: ${result.projects.length}`);
  lines.push(`- Truncated: ${result.truncated ? "yes" : "no"}`);

  const ignoreSummary = formatIgnoreSummary(result.ignore);
  if (ignoreSummary) lines.push(`- Ignore: ${ignoreSummary}`);

  lines.push("");

  result.projects.forEach((p, idx) => {
    lines.push(`${idx + 1}) ${p.name}`);
    lines.push(`   - dir: ${p.projectDir}`);

    const composeList = (p.composeFiles || []).map((c) => c.rel);
    lines.push(
      `   - compose: ${composeList.length ? composeList.join(", ") : "(none)"}`,
    );

    if (opts.includeChildren && p.dockerfiles?.length) {
      for (const d of p.dockerfiles) lines.push(`   - dockerfile: ${d.rel}`);
    }

    if (opts.hints && p.hints) {
      const h = p.hints;
      if (h.parseFailed) {
        lines.push("   - hints: compose read failed");
      } else {
        lines.push(
          `   - hints: host.docker.internal=${h.hasHostDockerInternal ? "true" : "false"} | docker.sock=${h.hasDockerSock ? "true" : "false"} | privileged=${h.hasPrivileged ? "true" : "false"}`,
        );
      }
    }
  });

  return lines.join("\n") + "\n";
}

function renderCandidatesMarkdown(result, opts) {
  const lines = [];
  lines.push("# Podshift Candidates Report");
  lines.push("");
  lines.push("## Scan");
  lines.push(`- Root: \`${result.root}\``);
  lines.push(`- Scanned entries: \`${result.scannedEntries}\``);
  lines.push(`- Ignored entries: \`${result.ignoredEntries}\``);
  lines.push(`- Projects found: \`${result.projects.length}\``);
  lines.push(`- Truncated: \`${result.truncated ? "yes" : "no"}\``);

  const ignoreSummary = formatIgnoreSummary(result.ignore);
  if (ignoreSummary) lines.push(`- Ignore: \`${ignoreSummary}\``);

  lines.push(
    `- Nested compose projects: \`${opts.includeChildProjects ? "included" : "collapsed"}\``,
  );
  lines.push("");

  lines.push("## Candidates");
  if (!result.projects.length) {
    lines.push("No candidates found.");
    return lines.join("\n") + "\n";
  }

  for (const p of result.projects) {
    lines.push(`### ${p.name}`);
    lines.push(`- Project dir: \`${p.projectDir}\``);

    if (p.composeFiles?.length) {
      lines.push("- Compose:");
      for (const c of p.composeFiles) lines.push(`  - \`${c.rel}\``);
    } else {
      lines.push("- Compose: (none)");
    }

    if (opts.includeChildren) {
      if (p.dockerfiles?.length) {
        lines.push("- Dockerfiles:");
        for (const d of p.dockerfiles) lines.push(`  - \`${d.rel}\``);
      } else {
        lines.push("- Dockerfiles: (none)");
      }
    }

    if (opts.hints && p.hints) {
      const h = p.hints;
      lines.push("- Hints:");
      if (h.parseFailed) lines.push("  - compose read failed");
      else {
        lines.push(
          `  - host.docker.internal: \`${Boolean(h.hasHostDockerInternal)}\``,
        );
        lines.push(`  - docker.sock mount: \`${Boolean(h.hasDockerSock)}\``);
        lines.push(
          `  - privileged/host namespaces: \`${Boolean(h.hasPrivileged)}\``,
        );
      }
    }

    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function writeOut(outAbs, content) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, content, "utf8");
}

export async function candidatesCommand(opts) {
  const rootAbs = path.resolve(opts.root || ".");
  const format = String(opts.format || "text").toLowerCase();
  const out = opts.out ? path.resolve(opts.out) : null;

  const includeChildren = Boolean(opts.includeChildren);
  const includeChildProjects = Boolean(opts.includeChildProjects);
  const hints = Boolean(opts.hints);

  const maxDepth = opts.maxDepth != null ? Number(opts.maxDepth) : 20;
  const maxEntries = opts.maxEntries != null ? Number(opts.maxEntries) : 250000;

  const scan = scanTree(rootAbs, {
    maxDepth,
    maxEntries,
    ignore: opts.ignore,
    ignoreFile: opts.ignoreFile,
    defaultIgnore: opts.defaultIgnore,
  });

  let projects = groupComposeProjects(rootAbs, scan.composeFiles);
  projects = collapseChildProjects(projects, includeChildProjects);
  attachDockerfilesToProjects(
    rootAbs,
    projects,
    scan.dockerfiles,
    includeChildren,
  );

  if (hints) {
    for (const p of projects) {
      const first = p.composeFiles?.[0]?.abs;
      if (!first) continue;
      try {
        const text = readFileBounded(first, 256 * 1024);
        p.hints = computeHintsFromComposeText(text);
      } catch {
        p.hints = { parseFailed: true };
      }
    }
  }

  const result = {
    root: rootAbs,
    scannedEntries: scan.scannedEntries,
    ignoredEntries: scan.ignoredEntries,
    truncated: scan.truncated,
    count: projects.length,
    ignore: scan.ignoreMeta,
    projects,
  };

  let output;
  if (format === "json") {
    output = JSON.stringify(result, null, 2) + "\n";
  } else if (format === "md" || format === "markdown") {
    output = renderCandidatesMarkdown(result, {
      includeChildren,
      hints,
      includeChildProjects,
    });
  } else {
    output = renderLegacyText(result, {
      includeChildren,
      hints,
      includeChildProjects,
    });
  }

  if (out) writeOut(out, output);

  process.stdout.write(output);

  if (out) {
    process.stdout.write(`\nReport written: ${out}\n`);
  }
}
