import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const baseDir = join(tmpdir(), `server-visible-identity-test-${process.pid}`);

async function loadModule() {
  vi.resetModules();
  return import("./server-visible-identity.mjs");
}

afterEach(async () => {
  process.env.XDG_CONFIG_HOME = baseDir;
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe("server-visible identity helpers", () => {
  it("reuses a stable runtime session id", async () => {
    process.env.XDG_CONFIG_HOME = baseDir;
    const identity = await loadModule();

    expect(identity.getRuntimeSessionId()).toBe(identity.getRuntimeSessionId());
    expect(identity.getRuntimeSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it("creates a distinct client request id per call", async () => {
    process.env.XDG_CONFIG_HOME = baseDir;
    const identity = await loadModule();

    const first = identity.createClientRequestId();
    const second = identity.createClientRequestId();

    expect(first).not.toBe(second);
  });

  it("persists a 64-char hex device id across module reloads", async () => {
    process.env.XDG_CONFIG_HOME = baseDir;

    const firstIdentity = await loadModule();
    const first = await firstIdentity.getPersistentDeviceId();

    const secondIdentity = await loadModule();
    const second = await secondIdentity.getPersistentDeviceId();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("falls back to an ephemeral device id when persistence fails", async () => {
    const brokenBase = join(baseDir, "broken-xdg-home");
    process.env.XDG_CONFIG_HOME = brokenBase;
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(brokenBase, "not a directory");

    const identity = await loadModule();
    const body = JSON.stringify({ messages: [] });
    const signed = await identity.injectServerVisibleMetadata(body, new URL("https://api.anthropic.com/v1/messages"));
    const parsed = JSON.parse(signed);
    expect(parsed.metadata.user_id).toMatch(/^user_[0-9a-f]{64}_account__session_/u);
    expect(parsed.metadata.user_id).toContain(identity.getRuntimeSessionId());
  });

  it("builds metadata.user_id in the captured Claude Code token-auth format", async () => {
    process.env.XDG_CONFIG_HOME = baseDir;
    const identity = await loadModule();

    const userId = identity.buildServerVisibleUserId({
      deviceId: "a".repeat(64),
      sessionId: "session-123",
      accountUuid: "account-456",
    });

    expect(userId).toBeTypeOf("string");
    expect(userId).toBe(`user_${"a".repeat(64)}_account_account-456_session_session-123`);
  });
});
