#!/usr/bin/env node

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, symlink, unlink, rm, copyFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..");
const PLUGIN_NAME = "opencode-anthropic-auth";
const PLUGIN_ENTRY = "opencode-anthropic-auth.js";
const DIST_DIR = join(PROJECT_ROOT, "dist");

function getPluginDir() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "opencode", "plugins");
}

const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;

function printEnvReminder() {
  console.log(yellow("\nNote: if using OpenCode v1.1.52 or earlier, set OPENCODE_DISABLE_DEFAULT_PLUGINS=1"));
  console.log(dim("This is not needed on newer versions where user plugins take priority."));
}

function shortPath(path) {
  const home = homedir();
  if (path.startsWith(home)) return "~" + path.slice(home.length);
  return path;
}

function checkExisting(path) {
  if (!existsSync(path)) {
    return { exists: false, isSymlink: false, target: null, isDir: false };
  }
  const stat = lstatSync(path);
  const isSymlink = stat.isSymbolicLink();
  let target = null;
  if (isSymlink) {
    try {
      target = readlinkSync(path);
    } catch {
      // ignore
    }
  }
  return { exists: true, isSymlink, target, isDir: stat.isDirectory() };
}

async function ensureSymlink(target, linkPath, label) {
  await mkdir(dirname(linkPath), { recursive: true });
  const existing = checkExisting(linkPath);

  if (existing.exists) {
    if (existing.isSymlink && existing.target === target) {
      console.log(green(`${label}: already linked.`));
      console.log(dim(`  ${shortPath(linkPath)} -> ${shortPath(target)}`));
      return false;
    }

    if (existing.isDir) {
      console.log(yellow(`${label}: replacing directory`));
      await rm(linkPath, { recursive: true, force: true });
    } else {
      console.log(yellow(`${label}: replacing existing file`));
      await unlink(linkPath);
    }
  }

  await symlink(target, linkPath);
  console.log(green(`${label}: linked.`));
  console.log(dim(`  ${shortPath(linkPath)} -> ${shortPath(target)}`));
  return true;
}

async function removePath(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }

  if (stat.isDirectory()) {
    await rm(path, { recursive: true, force: true });
    console.log(green(`${label}: removed directory ${shortPath(path)}/`));
  } else {
    await unlink(path);
    const kind = stat.isSymbolicLink() ? "symlink" : "file";
    console.log(green(`${label}: removed ${kind} ${shortPath(path)}`));
  }
  return true;
}

async function cmdLink() {
  console.log(bold(`Linking ${PLUGIN_NAME}...\n`));
  const pluginDir = getPluginDir();
  const pluginEntry = join(pluginDir, PLUGIN_ENTRY);
  const pluginTarget = join(PROJECT_ROOT, "index.mjs");

  const oldEntry = join(pluginDir, "opencode-anthropic-auth-plugin.js");
  if (existsSync(oldEntry) && oldEntry !== pluginEntry) {
    await unlink(oldEntry);
    console.log(dim("Plugin: removed old opencode-anthropic-auth-plugin.js"));
  }

  await ensureSymlink(pluginTarget, pluginEntry, "Plugin");
  console.log(dim("\nEdits to source files take effect immediately."));
  printEnvReminder();
}

async function cmdCopy() {
  console.log(bold(`Copying ${PLUGIN_NAME}...\n`));
  const pluginSrc = join(DIST_DIR, PLUGIN_ENTRY);
  if (!existsSync(pluginSrc)) {
    console.error(red("dist/ not found. Run `npm run build` first."));
    process.exit(1);
  }

  const pluginDir = getPluginDir();
  const pluginDest = join(pluginDir, PLUGIN_ENTRY);
  await mkdir(pluginDir, { recursive: true });

  const oldCopyDir = join(pluginDir, PLUGIN_NAME);
  if (existsSync(oldCopyDir)) {
    await rm(oldCopyDir, { recursive: true, force: true });
    console.log(dim("Plugin: removed old copy directory."));
  }

  if (existsSync(pluginDest)) await unlink(pluginDest);
  await copyFile(pluginSrc, pluginDest);

  console.log(green("Plugin: copied."));
  console.log(dim(`  ${shortPath(pluginDest)}`));
  console.log(dim("\nThis is a snapshot. Re-run to update."));
}

async function cmdUninstall() {
  console.log(bold(`Uninstalling ${PLUGIN_NAME}...\n`));

  let removed = false;
  const pluginDir = getPluginDir();
  const pluginEntry = join(pluginDir, PLUGIN_ENTRY);
  if (await removePath(pluginEntry, "Plugin")) removed = true;

  const oldEntry = join(pluginDir, "opencode-anthropic-auth-plugin.js");
  if (await removePath(oldEntry, "Plugin (old name)")) removed = true;

  const copyDir = join(pluginDir, PLUGIN_NAME);
  if (await removePath(copyDir, "Plugin")) removed = true;

  if (!removed) {
    console.log(dim("Nothing to remove. Not installed."));
  } else {
    console.log(dim("\nUninstalled."));
  }
}

const command = process.argv[2];

switch (command) {
  case "link":
    await cmdLink();
    break;
  case "copy":
    await cmdCopy();
    break;
  case "uninstall":
    await cmdUninstall();
    break;
  default:
    console.log(`${bold(`Installer for ${PLUGIN_NAME}`)}

${dim("Installs:")}
  Plugin  ${dim("->")}  ~/.config/opencode/plugins/${PLUGIN_ENTRY}

${dim("Usage:")}
  node scripts/install.mjs ${bold("link")}         Symlink plugin (development)
  node scripts/install.mjs ${bold("copy")}         Copy plugin (stable deployment)
  node scripts/install.mjs ${bold("uninstall")}    Remove plugin
`);
    process.exit(command ? 1 : 0);
}
