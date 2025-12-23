import path from "node:path";
import chalk from "chalk";

import { ensureDir, writeJson, writeText } from "../lib/fs.js";
import { loadCompose } from "../lib/compose.js";
import { discoverDockerfiles, readDockerfile } from "../lib/dockerfile.js";
import { evaluateRules } from "../lib/rules.js";
import { renderMarkdownReport } from "../lib/report.js";

export async function analyzeCommand(opts) {
  const repoRoot = path.resolve(opts.root);
  const composePath = path.resolve(repoRoot, opts.compose);
  const outDir = path.resolve(repoRoot, opts.out);

  await ensureDir(outDir);

  const compose = await loadCompose(composePath);
  const dockerfiles = await discoverDockerfiles(repoRoot);

  const dockerfileContents = {};
  for (const df of dockerfiles) {
    dockerfileContents[df] = await readDockerfile(df);
  }

  const evaluation = evaluateRules({
    repoRoot,
    composePath,
    compose,
    dockerfiles,
    dockerfileContents,
    strict: Boolean(opts.strict),
  });

  const reportMd = renderMarkdownReport(evaluation);

  await writeJson(path.join(outDir, "report.json"), evaluation);
  await writeJson(
    path.join(outDir, "recommendation.json"),
    evaluation.recommendation,
  );
  await writeText(path.join(outDir, "report.md"), reportMd);

  const { verdict } = evaluation.recommendation;
  const color =
    verdict === "GREEN"
      ? chalk.green
      : verdict === "YELLOW"
        ? chalk.yellow
        : chalk.red;

  console.log(color(`\nVerdict: ${verdict}`));
  console.log(`Report: ${path.join(outDir, "report.md")}\n`);
}
