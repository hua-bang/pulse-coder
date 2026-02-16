#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const packagesDir = path.join(rootDir, "packages");

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const allPackages = await discoverPackages(packagesDir);

  if (allPackages.length === 0) {
    throw new Error("No publishable packages were found in ./packages");
  }

  const selectedPackages = resolveSelectedPackages(allPackages, options.packages);
  const orderedPackages = sortByDependency(selectedPackages);
  const tag = options.tag || (isPrereleaseBump(options.bump) ? options.preid : "latest");

  printPlan(orderedPackages, options, tag);

  if (!options.skipVersion) {
    for (const pkg of orderedPackages) {
      await bumpPackageVersion(pkg, options.bump, options.preid, options.dryRun);
    }
  }

  if (!options.skipBuild) {
    for (const pkg of orderedPackages) {
      await runCommand("pnpm", ["build"], pkg.dir, options.dryRun);
    }
  }

  for (const pkg of orderedPackages) {
    const publishArgs = ["publish", "--no-git-checks", "--tag", tag];
    if (pkg.name.startsWith("@")) {
      publishArgs.push("--access", "public");
    }
    await runCommand("pnpm", publishArgs, pkg.dir, options.dryRun);
  }

  console.log("\nRelease flow completed.");
}

function parseArgs(argv) {
  const options = {
    packages: [],
    bump: "prerelease",
    preid: "alpha",
    tag: "",
    dryRun: false,
    skipBuild: false,
    skipVersion: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "--skip-version") {
      options.skipVersion = true;
      continue;
    }

    if (arg.startsWith("--packages=")) {
      options.packages.push(...splitCsv(arg.slice("--packages=".length)));
      continue;
    }

    if (arg === "--packages" || arg === "-p") {
      options.packages.push(...splitCsv(argv[index + 1] || ""));
      index += 1;
      continue;
    }

    if (arg.startsWith("--bump=")) {
      options.bump = arg.slice("--bump=".length);
      continue;
    }

    if (arg === "--bump") {
      options.bump = argv[index + 1] || options.bump;
      index += 1;
      continue;
    }

    if (arg.startsWith("--preid=")) {
      options.preid = arg.slice("--preid=".length);
      continue;
    }

    if (arg === "--preid") {
      options.preid = argv[index + 1] || options.preid;
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
      continue;
    }

    if (arg === "--tag") {
      options.tag = argv[index + 1] || options.tag;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    options.packages.push(arg);
  }

  if (options.help) {
    return options;
  }

  const allowedBumps = new Set([
    "major",
    "minor",
    "patch",
    "prerelease",
    "premajor",
    "preminor",
    "prepatch",
  ]);

  if (!allowedBumps.has(options.bump)) {
    throw new Error(
      `Invalid --bump value \"${options.bump}\". Allowed values: ${Array.from(allowedBumps).join(", ")}`,
    );
  }

  options.packages = Array.from(new Set(options.packages.filter(Boolean)));
  return options;
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function discoverPackages(baseDir) {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageDir = path.join(baseDir, entry.name);
    const packageJsonPath = path.join(packageDir, "package.json");

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      if (packageJson.private) {
        continue;
      }

      if (!packageJson.name || !packageJson.version) {
        throw new Error(`Missing name/version in ${packageJsonPath}`);
      }

      packages.push({
        dirName: entry.name,
        dir: packageDir,
        packageJsonPath,
        name: packageJson.name,
        version: packageJson.version,
        workspaceDeps: getWorkspaceDeps(packageJson),
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return packages;
}

function getWorkspaceDeps(packageJson) {
  const sections = [
    packageJson.dependencies || {},
    packageJson.optionalDependencies || {},
    packageJson.peerDependencies || {},
  ];

  const deps = [];

  for (const section of sections) {
    for (const [depName, depVersion] of Object.entries(section)) {
      if (typeof depVersion === "string" && depVersion.startsWith("workspace:")) {
        deps.push(depName);
      }
    }
  }

  return deps;
}

function resolveSelectedPackages(allPackages, selected) {
  if (selected.length === 0) {
    return allPackages;
  }

  const aliases = new Map();

  for (const pkg of allPackages) {
    aliases.set(pkg.name, pkg);
    aliases.set(pkg.dirName, pkg);
  }

  const resolved = [];
  for (const name of selected) {
    const pkg = aliases.get(name);
    if (!pkg) {
      const available = allPackages.map((item) => `${item.dirName} (${item.name})`).join(", ");
      throw new Error(`Unknown package \"${name}\". Available packages: ${available}`);
    }
    resolved.push(pkg);
  }

  return Array.from(new Set(resolved));
}

function sortByDependency(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const graph = new Map();
  const inDegree = new Map();

  for (const pkg of packages) {
    graph.set(pkg.name, []);
    inDegree.set(pkg.name, 0);
  }

  for (const pkg of packages) {
    for (const dep of pkg.workspaceDeps) {
      if (!byName.has(dep)) {
        continue;
      }
      graph.get(dep).push(pkg.name);
      inDegree.set(pkg.name, (inDegree.get(pkg.name) || 0) + 1);
    }
  }

  const queue = Array.from(inDegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([name]) => name)
    .sort();

  const orderedNames = [];

  while (queue.length > 0) {
    const current = queue.shift();
    orderedNames.push(current);

    for (const next of graph.get(current) || []) {
      const nextDegree = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (orderedNames.length !== packages.length) {
    throw new Error("Circular workspace dependency detected in selected packages.");
  }

  return orderedNames.map((name) => byName.get(name));
}

function isPrereleaseBump(bump) {
  return bump.startsWith("pre") || bump === "prerelease";
}

async function bumpPackageVersion(pkg, bump, preid, dryRun) {
  const nextVersion = incrementVersion(pkg.version, bump, preid);
  console.log(`\n$ bump ${pkg.name}: ${pkg.version} -> ${nextVersion}`);

  if (dryRun) {
    pkg.version = nextVersion;
    return;
  }

  const packageJson = JSON.parse(await fs.readFile(pkg.packageJsonPath, "utf8"));
  packageJson.version = nextVersion;
  await fs.writeFile(pkg.packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  pkg.version = nextVersion;
}

function incrementVersion(version, bump, preid) {
  const parsed = parseVersion(version);

  switch (bump) {
    case "major":
      return formatVersion({ major: parsed.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatVersion({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
    case "patch":
      return formatVersion({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 });
    case "premajor":
      return formatVersion({ major: parsed.major + 1, minor: 0, patch: 0, preid, prerelease: 0 });
    case "preminor":
      return formatVersion({ major: parsed.major, minor: parsed.minor + 1, patch: 0, preid, prerelease: 0 });
    case "prepatch":
      return formatVersion({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1, preid, prerelease: 0 });
    case "prerelease":
      if (!parsed.preid) {
        return formatVersion({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch + 1,
          preid,
          prerelease: 0,
        });
      }

      if (parsed.preid === preid) {
        return formatVersion({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          preid,
          prerelease: parsed.prerelease + 1,
        });
      }

      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        preid,
        prerelease: 0,
      });
    default:
      throw new Error(`Unsupported bump type: ${bump}`);
  }
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/.exec(version);

  if (!match) {
    throw new Error(
      `Unsupported version format \"${version}\". Expected x.y.z or x.y.z-preid.n`,
    );
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    preid: match[4] || "",
    prerelease: match[5] ? Number.parseInt(match[5], 10) : -1,
  };
}

function formatVersion({ major, minor, patch, preid = "", prerelease = -1 }) {
  const core = `${major}.${minor}.${patch}`;
  if (!preid) {
    return core;
  }
  return `${core}-${preid}.${prerelease}`;
}

function printHelp() {
  console.log(`Usage: pnpm release -- [options]\n\nOptions:\n  -p, --packages      Comma-separated package names or directory names\n  --bump              Version bump strategy (default: prerelease)\n  --preid             Prerelease identifier (default: alpha)\n  --tag               npm dist-tag (default: alpha for pre bumps, latest otherwise)\n  --skip-version      Skip version bump phase\n  --skip-build        Skip build phase\n  --dry-run           Print commands only\n  -h, --help          Show this help message\n\nExamples:\n  pnpm release\n  pnpm release -- --packages=engine,cli\n  pnpm release -- --packages=engine,cli --bump=patch --tag=latest\n  pnpm release -- --packages=engine,cli --dry-run`);
}

function printPlan(packages, options, tag) {
  console.log("Release plan:");
  console.log(`- packages: ${packages.map((pkg) => pkg.name).join(", ")}`);
  console.log(`- bump: ${options.skipVersion ? "skipped" : options.bump}`);
  console.log(`- build: ${options.skipBuild ? "skipped" : "enabled"}`);
  console.log(`- dist-tag: ${tag}`);
  console.log(`- dry-run: ${options.dryRun ? "yes" : "no"}`);
}

function runCommand(command, args, cwd, dryRun) {
  const rendered = `${command} ${args.join(" ")}`;
  console.log(`\n$ ${rendered}`);

  if (dryRun) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${rendered}`));
    });
  });
}

main().catch((error) => {
  console.error(`\nRelease flow failed: ${error.message}`);
  process.exit(1);
});
