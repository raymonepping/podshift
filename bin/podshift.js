#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";

import { analyzeCommand } from "../src/commands/analyze.js";
import { migrateCommand } from "../src/commands/migrate.js";
import { runCommand } from "../src/commands/run.js";
import { cleanCommand } from "../src/commands/clean.js";
import { restoreCommand } from "../src/commands/restore.js";
import { archivesCommand } from "../src/commands/archives.js";
import { candidatesCommand } from "../src/commands/candidates.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name("podshift")
  .description(
    "Podshift: migrate Docker Compose projects to Podman-friendly workflows",
  )
  .version(version);

program
  .command("analyze")
  .requiredOption("--root <path>", "Repo root")
  .requiredOption("--compose <path>", "Path to docker-compose.yml")
  .option("--out <path>", "Output folder", "./output/podshift")
  .option("--strict", "Enable stricter checks", false)
  .action(analyzeCommand);

program
  .command("migrate")
  .requiredOption("--root <path>", "Repo root")
  .requiredOption("--compose <path>", "Path to docker-compose.yml")
  .option("--out <path>", "Output folder", "./output/podshift")
  .option("--force", "Overwrite outputs if they exist", false)
  .option(
    "--format-yaml",
    "Format podman-compose.yml with Prettier if available",
    true,
  )
  .option("--no-format-yaml", "Disable YAML formatting")
  .option(
    "--prettier-config <path>",
    "Path to a Prettier config file (optional)",
  )
  .action(migrateCommand);

program
  .command("run")
  .option("--file <path>", "Compose file to run", "./podman-compose.yml")
  .option("--project-dir <path>", "Project directory", ".")
  .option("--build", "Build images", true)
  .option("--detach", "Run detached", true)
  .option("--dry-run", "Print commands only", false)
  .action(runCommand);

program
  .command("clean")
  .description(
    "Archive or delete Docker artifacts after a successful migration",
  )
  .option("--root <path>", "Repo root", ".")
  .option(
    "--compose <path>",
    "Path to docker-compose.yml (relative to root)",
    "./docker-compose.yml",
  )
  .option("--yes", "Skip confirmation prompts")
  .option("--delete", "Delete files instead of archiving them")
  .option("--dry-run", "Print actions without changing files")
  .action(async (opts) => {
    await cleanCommand(opts);
  });

program
  .command("restore")
  .description(
    "Restore archived Docker artifacts from .podshift/archive back into the repo",
  )
  .option("--root <path>", "Repo root", ".")
  .option(
    "--from <timestampOrPath>",
    "Archive folder name under .podshift/archive or an absolute path",
  )
  .option("--overwrite", "Overwrite destination files if they exist")
  .option("--yes", "Skip confirmation prompts")
  .option("--dry-run", "Print actions without changing files")
  .action(async (opts) => {
    await restoreCommand(opts);
  });

program
  .command("archives")
  .description("List and inspect Podshift archives under .podshift/archive")
  .option("--root <path>", "Repo root", ".")
  .option("--limit <n>", "Max archives to show (default: 25)", "25")
  .option("--show <timestampOrPath>", "Show contents of a specific archive")
  .option("--latest", "Show contents of the latest archive (shortcut)")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    await archivesCommand(opts);
  });

program
  .command("candidates")
  .description(
    "Scan a directory tree for Docker Compose projects (and optional Dockerfiles)",
  )
  .option("--root <path>", "Root directory to scan", ".")
  .option("--format <text|md|json>", "Output format", "text")
  .option(
    "--include-child-projects",
    "Include nested Compose projects (default: collapsed under the parent project)",
    false,
  )
  .option("--out <path>", "Write output to a file in addition to stdout")
  .option("--include-children", "List Dockerfiles under each Compose project")
  .option(
    "--hints",
    "Add fast hints (docker.sock, privileged/host, host.docker.internal)",
  )
  .option("--ignore <pattern...>", "Ignore patterns (repeatable)")
  .option(
    "--ignore-file <path>",
    "Ignore file (default: .podshiftignore if present)",
  )
  .option("--no-default-ignore", "Disable built-in ignore defaults")
  .option(
    "--max-entries <n>",
    "Maximum entries to scan before truncating",
    (v) => Number(v),
    80000,
  )
  .option(
    "--max-depth <n>",
    "Maximum directory depth to scan",
    (v) => Number(v),
    18,
  )
  .option("--quiet", "Reduce output (text mode)")
  .action(candidatesCommand);

program.parse(process.argv);
