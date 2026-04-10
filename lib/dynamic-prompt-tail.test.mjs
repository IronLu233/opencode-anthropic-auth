import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDynamicPromptTail } from "./dynamic-prompt-tail.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildDynamicPromptTail", () => {
  it("builds dynamic runtime sections for the current request", () => {
    const tail = buildDynamicPromptTail({ modelName: "claude-opus-4-6" });

    expect(tail).toContain("# Environment");
    expect(tail).toContain(`Working directory: ${process.cwd()}`);
    expect(tail).toContain("You are powered by the model named Opus 4.6. The exact model ID is claude-opus-4-6.");
    expect(tail).toContain("Assistant knowledge cutoff is May 2025.");
    expect(tail).toContain("The latest available models are:");
    expect(tail).toContain("gitStatus: This is the git status at the start of the conversation.");
    expect(tail).toContain("Recent commits:");
  });

  it("gracefully handles non-git directories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dynamic-prompt-tail-"));
    tempDirs.push(cwd);

    const tail = buildDynamicPromptTail({ cwd, modelName: "claude-sonnet-4-5-20250929" });

    expect(tail).toContain(`Working directory: ${cwd}`);
    expect(tail).toContain("Is directory a git repo: No");
    expect(tail).toContain("Current branch: unknown");
    expect(tail).toContain("Main branch (you will usually use this for PRs): main");
    expect(tail).toContain("(not a git repository)");
  });
});
