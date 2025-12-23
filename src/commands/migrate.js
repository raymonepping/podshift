// src/commands/migrate.js
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

import { ensureDir, writeJson, writeText } from "../lib/fs.js";
import { loadCompose, saveCompose } from "../lib/compose.js";
import { transformForPodman } from "../lib/transform.js";
import { formatYamlText } from "../lib/format.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function migrateCommand(opts) {
  const repoRoot = path.resolve(opts.root);
  const composePath = path.resolve(repoRoot, opts.compose);
  const outDir = path.resolve(repoRoot, opts.out);

  await ensureDir(outDir);

  const compose = await loadCompose(composePath);

  const result = await transformForPodman({
    repoRoot,
    compose,
    composePath,
  });

  const podmanComposePath = path.join(repoRoot, "podman-compose.yml");
  const migrationDocPath = path.join(repoRoot, "MIGRATION.md");

  if (!opts.force) {
    if (await exists(podmanComposePath))
      throw new Error(
        `Refusing to overwrite: ${podmanComposePath} (use --force)`,
      );
    if (await exists(migrationDocPath))
      throw new Error(
        `Refusing to overwrite: ${migrationDocPath} (use --force)`,
      );
  }

  // 1) Write podman-compose.yml
  await saveCompose(podmanComposePath, result.podmanCompose);

  // 2) Optional: format YAML with Prettier (soft dependency)
  // Default: on. Disable with --no-format-yaml
  const formatYaml = opts.formatYaml !== false;
  const prettierConfig = opts.prettierConfig || null;

  if (formatYaml) {
    try {
      const original = await fs.readFile(podmanComposePath, "utf8");
      const formatted = await formatYamlText(original, podmanComposePath, {
        prettierConfig,
      });

      if (formatted.used && formatted.text !== original) {
        await fs.writeFile(podmanComposePath, formatted.text, "utf8");
      }
      // If prettier is missing or fails, we keep the original output silently.
    } catch {
      // Keep migration non-blocking.
    }
  }

  // 3) Write env overlays if any
  for (const envWrite of result.envWrites) {
    if (!opts.force && (await exists(envWrite.dest))) {
      throw new Error(`Refusing to overwrite: ${envWrite.dest} (use --force)`);
    }
    await ensureDir(path.dirname(envWrite.dest));
    await fs.writeFile(envWrite.dest, envWrite.content, "utf8");
  }

  // 4) MIGRATION.md
  await writeText(migrationDocPath, result.migrationMd);

  // 5) migrate.json
  await writeJson(path.join(outDir, "migrate.json"), {
    generated: {
      podmanComposePath,
      migrationDocPath,
      envFiles: result.envWrites.map((x) => x.dest),
      formatYaml: Boolean(formatYaml),
      prettierConfig: prettierConfig || null,
    },
    changes: result.changes,
  });

  console.log(chalk.green("Migration artifacts generated:"));
  console.log(`- ${podmanComposePath}`);
  console.log(`- ${migrationDocPath}`);
  for (const ef of result.envWrites) console.log(`- ${ef.dest}`);
  console.log(`- ${path.join(outDir, "migrate.json")}`);
}
