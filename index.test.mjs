import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = {
  debug: false,
  headers: {
    emulation_profile: "claude-cli-2.0.74",
    overrides: {},
    disable: [],
    billing_header: true,
    cch_signing: false,
  },
  stream: {
    close_on_message_stop: true,
    idle_timeout_seconds: 180,
  },
};

vi.mock("./lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadConfig: vi.fn(() => structuredClone(config)),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { AnthropicAuthPlugin } from "./index.mjs";
import { ANTHROPIC_REPLACEMENT_PROMPT } from "./lib/anthropic-system-prompt.mjs";
import { loadConfig } from "./lib/config.mjs";

function makeBody(overrides = {}) {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    stream: false,
    system: [
      {
        type: "text",
        text: `You are OpenCode, the best coding agent on the planet.\n\nIMPORTANT: Use TodoWrite throughout the conversation to plan and track work.\n\nYou are powered by the model named foo`,
      },
    ],
    messages: [{ role: "user", content: "hello world" }],
    tools: [{ name: "bash", description: "Run shell", input_schema: { type: "object", properties: {} } }],
    ...overrides,
  });
}

function mockGetAuth(key = "test-key") {
  return vi.fn(() => Promise.resolve({ type: "api", key }));
}

describe("AnthropicAuthPlugin", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    Object.assign(config, {
      debug: false,
      headers: {
        emulation_profile: "claude-cli-2.0.74",
        overrides: {},
        disable: [],
        billing_header: true,
        cch_signing: false,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exports a plugin with anthropic auth loader", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    expect(plugin.auth.provider).toBe("anthropic");
    expect(plugin.auth.methods).toEqual([{ type: "api", label: "Anthropic API Key" }]);
    expect(plugin.auth.loader).toBeTypeOf("function");
  });

  it("leaves system untouched at the early plugin hook", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    const output = {
      system: [
        "You are Claude Code, Anthropic's official CLI for Claude.",
        `You are Claude Code, Anthropic's official CLI for Claude.\n${ANTHROPIC_REPLACEMENT_PROMPT}`,
        "x-anthropic-billing-header: cc_version=2.0.74.abc; cc_entrypoint=cli;",
        `You are OpenCode, the best coding agent on the planet.\n\nIMPORTANT: Use TodoWrite throughout the conversation to plan and track work.\n\nYou are powered by the model named foo`,
      ],
    };

    plugin["experimental.chat.system.transform"]({ model: { providerID: "anthropic" } }, output);
    expect(output.system).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
      `You are Claude Code, Anthropic's official CLI for Claude.\n${ANTHROPIC_REPLACEMENT_PROMPT}`,
      "x-anthropic-billing-header: cc_version=2.0.74.abc; cc_entrypoint=cli;",
      `You are OpenCode, the best coding agent on the planet.\n\nIMPORTANT: Use TodoWrite throughout the conversation to plan and track work.\n\nYou are powered by the model named foo`,
    ]);
  });

  it("auth.loader returns apiKey and fetch function", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    const loaded = await plugin.auth.loader(mockGetAuth());
    expect(loaded.fetch).toBeTypeOf("function");
    expect(loaded.apiKey).toBe("test-key");
  });

  it("auth.loader returns empty apiKey when no stored auth", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    const getAuth = vi.fn(() => Promise.resolve(undefined));
    const loaded = await plugin.auth.loader(getAuth);
    expect(loaded.fetch).toBeTypeOf("function");
    expect(loaded.apiKey).toBe("");
  });

  it("applies token-auth disguise and metadata shaping", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const { fetch: disguisedFetch } = await plugin.auth.loader(mockGetAuth());
    await disguisedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: makeBody(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("https://api.anthropic.com/v1/messages?beta=true");
    expect(init.headers.get("x-api-key")).toBeNull();
    expect(init.headers.get("authorization")).toBe("Bearer test-key");
    expect(init.headers.get("user-agent")).toMatch(/^claude-cli\//);
    expect(init.headers.get("x-app")).toBe("cli");

    const parsed = JSON.parse(init.body);
    expect(parsed.system[0].text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.messages[0].content).toContain("<system-reminder>");
    expect(parsed.metadata.user_id).toBeTypeOf("string");
  });

  it("renames tool names to Claude Code token-auth casing", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const { fetch: disguisedFetch } = await plugin.auth.loader(mockGetAuth());
    await disguisedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: makeBody(),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.tools[0].name).toBe("Bash");
    expect(parsed.tools[0].name).not.toMatch(/^mcp_/);
  });

  it("sets Accept to text/event-stream for streaming requests", async () => {
    mockFetch.mockResolvedValue(
      new Response("data: {}", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const { fetch: disguisedFetch } = await plugin.auth.loader(mockGetAuth());
    await disguisedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: makeBody({ stream: true }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("accept")).toBe("text/event-stream");
  });

  it("sets Accept to application/json for non-streaming requests", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const { fetch: disguisedFetch } = await plugin.auth.loader(mockGetAuth());
    await disguisedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: makeBody({ stream: false }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("accept")).toBe("application/json");
  });

  it("does not inject a billing header block in token-auth mode", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const { fetch: disguisedFetch } = await plugin.auth.loader(mockGetAuth());
    await disguisedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: makeBody(),
    });

    const [, init] = mockFetch.mock.calls[0];
    const systemTexts = JSON.parse(init.body).system.map((block) => block.text);
    expect(systemTexts.some((text) => text.startsWith("x-anthropic-billing-header:"))).toBe(false);
  });

  it("preserves existing authorization header auth", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const { fetch: disguisedFetch } = await plugin.auth.loader(mockGetAuth());
    await disguisedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer existing-token",
      },
      body: makeBody(),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("authorization")).toBe("Bearer existing-token");
    expect(init.headers.get("x-api-key")).toBeNull();
  });

  it("loads config and does not crash on startup", async () => {
    await expect(AnthropicAuthPlugin({ client: {} })).resolves.toBeTruthy();
    expect(loadConfig).toHaveBeenCalled();
  });
});
