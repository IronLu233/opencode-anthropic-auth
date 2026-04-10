import { execSync } from "node:child_process";
import os from "node:os";

const KNOWLEDGE_CUTOFF_BY_MODEL = [
  [/claude-sonnet-4-6/u, "August 2025"],
  [/claude-opus-4-6/u, "May 2025"],
  [/claude-opus-4-5/u, "May 2025"],
  [/claude-haiku-4/u, "February 2025"],
  [/claude-opus-4/u, "January 2025"],
  [/claude-sonnet-4/u, "January 2025"],
];

const LATEST_MODEL_INFO = [
  "The latest available models are:",
  "- Claude Opus 4.6: claude-opus-4-6",
  "- Claude Sonnet 4.6: claude-sonnet-4-6",
  "- Claude Haiku 4.5: claude-haiku-4-5-20251001",
].join("\n");

function currentDateIso() {
  return new Date().toISOString().slice(0, 10);
}

function safeExec(command, cwd) {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function detectGitRepo(cwd) {
  return safeExec("git rev-parse --is-inside-work-tree", cwd) === "true";
}

function detectCurrentBranch(cwd, isGitRepo) {
  if (!isGitRepo) return "unknown";
  return safeExec("git rev-parse --abbrev-ref HEAD", cwd) || "unknown";
}

function detectMainBranch(cwd, isGitRepo) {
  if (!isGitRepo) return "main";
  const remoteHead = safeExec("git symbolic-ref refs/remotes/origin/HEAD --short", cwd);
  return remoteHead ? remoteHead.replace(/^origin\//u, "") : "main";
}

function detectGitStatus(cwd, isGitRepo) {
  if (!isGitRepo) return "(not a git repository)";
  return safeExec("git status --porcelain=v1", cwd) || "(clean working tree)";
}

function detectRecentCommits(cwd, isGitRepo) {
  if (!isGitRepo) return "(no commits available)";
  return safeExec("git log --oneline -5", cwd) || "(no commits available)";
}

function humanModelName(modelName) {
  if (!modelName) return "Claude";
  const normalized = modelName.toLowerCase();
  const match = normalized.match(/claude-(haiku|sonnet|opus)-(\d+)-(\d+)/u);
  if (!match) return modelName;
  const [, family, major, minor] = match;
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

function detectKnowledgeCutoff(modelName) {
  const normalized = (modelName || "").toLowerCase();
  for (const [pattern, cutoff] of KNOWLEDGE_CUTOFF_BY_MODEL) {
    if (pattern.test(normalized)) return cutoff;
  }
  return null;
}

/**
 * @param {{ cwd?: string, modelName?: string }} [options]
 * @returns {string}
 */
export function buildDynamicPromptTail(options = {}) {
  const cwd = options.cwd || process.cwd();
  const modelName = options.modelName || "claude-sonnet-4-5-20250929";
  const isGitRepo = detectGitRepo(cwd);
  const branch = detectCurrentBranch(cwd, isGitRepo);
  const mainBranch = detectMainBranch(cwd, isGitRepo);
  const gitStatus = detectGitStatus(cwd, isGitRepo);
  const recentCommits = detectRecentCommits(cwd, isGitRepo);
  const knowledgeCutoff = detectKnowledgeCutoff(modelName);

  return [
    "# Environment",
    `Working directory: ${cwd}`,
    `Is directory a git repo: ${isGitRepo ? "Yes" : "No"}`,
    `Platform: ${process.platform}`,
    `OS Version: ${os.type()} ${os.release()}`,
    `Today's date: ${currentDateIso()}`,
    `You are powered by the model named ${humanModelName(modelName)}. The exact model ID is ${modelName}.`,
    ...(knowledgeCutoff ? [`Assistant knowledge cutoff is ${knowledgeCutoff}.`] : []),
    LATEST_MODEL_INFO,
    "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    `Current branch: ${branch}`,
    "",
    `Main branch (you will usually use this for PRs): ${mainBranch}`,
    "",
    "Status:",
    gitStatus,
    "",
    "Recent commits:",
    recentCommits,
  ].join("\n");
}
