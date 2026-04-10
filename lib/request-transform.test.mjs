import { describe, expect, it } from "vitest";
import {
  buildRequestHeaders,
  injectBillingHeaderBlock,
  transformBodySinglePass,
  transformRequestBody,
  transformRequestUrl,
} from "./request-transform.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";

describe("buildRequestHeaders", () => {
  it("converts x-api-key into bearer auth for anthropic requests", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: { "x-api-key": "api-key", "content-type": "application/json" } },
      null,
      DEFAULT_CONFIG.headers,
      "claude-sonnet-4-5",
      new URL("https://api.anthropic.com/v1/messages"),
    );

    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer api-key");
    expect(headers.get("user-agent")).toMatch(/^claude-cli\//);
  });

  it("replaces auth with bearer token when access token is provided", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: { "x-api-key": "api-key" } },
      "override-token",
      DEFAULT_CONFIG.headers,
      "claude-sonnet-4-5",
      new URL("https://api.anthropic.com/v1/messages"),
    );

    expect(headers.get("authorization")).toBe("Bearer override-token");
    expect(headers.get("x-api-key")).toBeNull();
  });
});

describe("transformRequestBody", () => {
  it("rewrites the system prompt without adding tool prefixes", () => {
    const transformed = transformRequestBody(
      JSON.stringify({
        system:
          "You are OpenCode, the best coding agent on the planet.\n\nIMPORTANT: Use TodoWrite throughout the conversation to plan and track work.\n\nYou are powered by the model named foo",
        tools: [{ name: "bash" }],
        messages: [{ role: "assistant", content: [{ type: "tool_use", name: "bash" }] }],
      }),
    );

    const parsed = JSON.parse(transformed);
    expect(parsed.system).toContain("You are an interactive CLI tool that helps users with software engineering tasks");
    expect(parsed.tools[0].name).toBe("bash");
    expect(parsed.messages[0].content[0].name).toBe("bash");
  });

  it("replaces OpenCode/Open Code branding in outbound text fields", () => {
    const transformed = transformRequestBody(
      JSON.stringify({
        system: "You are OpenCode. open code should become claude branded.",
        tools: [{ name: "bash", description: "Run commands in OpenCode or open code mode" }],
        messages: [
          { role: "user", content: "I use OpenCode daily." },
          { role: "assistant", content: [{ type: "text", text: "Open Code is great; opencode too." }] },
        ],
      }),
    );

    const parsed = JSON.parse(transformed);
    expect(parsed.system).toContain("ClaudeCode");
    expect(parsed.tools[0].description).toContain("ClaudeCode");
    expect(parsed.tools[0].description).toContain("claude code");
    expect(parsed.messages[0].content).toContain("ClaudeCode");
    expect(parsed.messages[1].content[0].text).toContain("Claude Code");
    expect(parsed.messages[1].content[0].text).toContain("claudecode");
  });
});

describe("transformBodySinglePass", () => {
  it("keeps Claude system prompt and injects original system into first user system-reminder", async () => {
    const transformed = await transformBodySinglePass(
      JSON.stringify({
        model: "claude-opus-4-6",
        system:
          "You are OpenCode, the best coding agent on the planet.\n\nIMPORTANT: Use TodoWrite throughout the conversation to plan and track work.\n\nYou are powered by the model named foo",
        messages: [{ role: "user", content: "hello" }],
      }),
      new URL("https://api.anthropic.com/v1/messages"),
      DEFAULT_CONFIG.headers,
      "a".repeat(64),
    );

    const parsed = JSON.parse(transformed);
    expect(parsed.system).toHaveLength(2);
    expect(parsed.system[0].text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    expect(parsed.system[1].text).toContain(
      "You are an interactive CLI tool that helps users with software engineering tasks",
    );
    expect(parsed.system[1].text).toContain("# Environment");
    expect(parsed.system[1].text).toContain(
      "You are powered by the model named Opus 4.6. The exact model ID is claude-opus-4-6.",
    );
    expect(parsed.system[1].text).toContain("Assistant knowledge cutoff is May 2025.");
    expect(parsed.system[1].text).toContain("gitStatus: This is the git status at the start of the conversation.");
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toContain("<system-reminder>");
    expect(parsed.messages[0].content).toContain(
      "As you answer the user's questions, you can use the following context:",
    );
    expect(parsed.messages[0].content).toContain("# claudeMd");
    expect(parsed.messages[0].content).toContain("ClaudeCode, the best coding agent on the planet");
    expect(parsed.messages[0].content).toContain("# currentDate");
    expect(parsed.messages[1].content).toBe("hello");
  });
});

describe("injectBillingHeaderBlock", () => {
  it("injects a single billing header block for anthropic requests", () => {
    const body = injectBillingHeaderBlock(
      JSON.stringify({
        messages: [{ role: "user", content: "hello world" }],
        system: [{ type: "text", text: "hello" }],
      }),
      new URL("https://api.anthropic.com/v1/messages"),
      DEFAULT_CONFIG.headers,
    );

    const parsed = JSON.parse(body);
    expect(parsed.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(parsed.system).toHaveLength(2);
  });
});

describe("transformRequestUrl", () => {
  it("adds beta=true for messages requests", () => {
    const { requestUrl } = transformRequestUrl("https://api.anthropic.com/v1/messages");
    expect(requestUrl.toString()).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });
});
