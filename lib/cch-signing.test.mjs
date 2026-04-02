import { describe, expect, it } from "vitest";

import { signSerializedBodyCch } from "./cch-signing.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBody({
  header = "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;",
  suffix = "alpha",
  model = "claude-sonnet-4-20250514",
  extra = {},
} = {}) {
  return JSON.stringify({
    system: [{ type: "text", text: header }],
    messages: [{ role: "user", content: suffix }],
    model,
    ...extra,
  });
}

function extractCch(serializedBody) {
  return serializedBody.match(/\bcch=([0-9a-f]{5})\b/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Golden reference values
// ---------------------------------------------------------------------------
// These were computed independently using xxhash-wasm with seed
// 0x6E52736AC806831E against exact body bytes. If the hash function,
// seed, mask, or encoding changes, these tests catch it immediately.

const GOLDEN = {
  minimal: {
    body: JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
      model: "claude-sonnet-4-20250514",
    }),
    expectedCch: "0ba46",
  },
  realistic: {
    body: JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.90.0dc; cc_entrypoint=cli; cch=00000;",
        },
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        {
          type: "text",
          text: "System instructions here with details about behavior.",
        },
      ],
      messages: [
        {
          role: "user",
          content: "hello world this is a test message with enough chars",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will help you." },
            {
              type: "tool_use",
              id: "tool_1",
              name: "mcp_read",
              input: { path: "/tmp/test.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "file contents here",
            },
          ],
        },
        { role: "assistant", content: "Here is what I found." },
        { role: "user", content: "thanks, now do something else" },
      ],
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      stream: true,
    }),
    expectedCch: "bbbc6",
  },
  unicode: {
    body: JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [
        {
          role: "user",
          content: "emoji test: 🎉🔥 and CJK: 你好世界 and accents: café résumé",
        },
      ],
      model: "claude-sonnet-4-20250514",
    }),
    expectedCch: "20d57",
  },
  emptyMessages: {
    body: JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [],
      model: "claude-sonnet-4-20250514",
    }),
    expectedCch: "663ba",
  },
};

// ---------------------------------------------------------------------------
// Core algorithm tests
// ---------------------------------------------------------------------------

describe("signSerializedBodyCch", () => {
  describe("golden reference values", () => {
    it("produces correct cch for a minimal request body", async () => {
      const signed = await signSerializedBodyCch(GOLDEN.minimal.body);
      expect(extractCch(signed)).toBe(GOLDEN.minimal.expectedCch);
    });

    it("produces correct cch for a realistic multi-turn request with tools", async () => {
      const signed = await signSerializedBodyCch(GOLDEN.realistic.body);
      expect(extractCch(signed)).toBe(GOLDEN.realistic.expectedCch);
    });

    it("produces correct cch for unicode content (emoji, CJK, accents)", async () => {
      const signed = await signSerializedBodyCch(GOLDEN.unicode.body);
      expect(extractCch(signed)).toBe(GOLDEN.unicode.expectedCch);
    });

    it("produces correct cch for empty messages array", async () => {
      const signed = await signSerializedBodyCch(GOLDEN.emptyMessages.body);
      expect(extractCch(signed)).toBe(GOLDEN.emptyMessages.expectedCch);
    });
  });

  describe("determinism", () => {
    it("returns identical output for identical input across calls", async () => {
      const body = GOLDEN.minimal.body;
      const first = await signSerializedBodyCch(body);
      const second = await signSerializedBodyCch(body);
      const third = await signSerializedBodyCch(body);
      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });

  describe("output format", () => {
    it("produces exactly 5 lowercase hex characters", async () => {
      const signed = await signSerializedBodyCch(GOLDEN.minimal.body);
      expect(extractCch(signed)).toMatch(/^[0-9a-f]{5}$/);
    });

    it("preserves exact body length after signing (same-length replacement)", async () => {
      for (const fixture of Object.values(GOLDEN)) {
        const signed = await signSerializedBodyCch(fixture.body);
        expect(signed.length).toBe(fixture.body.length);
      }
    });

    it("never produces the placeholder value 00000 as output", async () => {
      // While theoretically possible for one specific input, it should not
      // happen for any of our golden fixtures.
      for (const fixture of Object.values(GOLDEN)) {
        const signed = await signSerializedBodyCch(fixture.body);
        expect(signed).not.toContain("cch=00000;");
      }
    });
  });

  describe("byte-level sensitivity", () => {
    it("changes cch when the user message content changes", async () => {
      const base = await signSerializedBodyCch(GOLDEN.minimal.body);
      const altered = await signSerializedBodyCch(GOLDEN.minimal.body.replace('"hello"', '"world"'));
      expect(extractCch(base)).toBe(GOLDEN.minimal.expectedCch);
      expect(extractCch(altered)).not.toBe(GOLDEN.minimal.expectedCch);
    });

    it("changes cch when the model name changes", async () => {
      const base = await signSerializedBodyCch(GOLDEN.minimal.body);
      const altered = await signSerializedBodyCch(GOLDEN.minimal.body.replace("sonnet-4", "opus-4"));
      expect(extractCch(base)).toBe(GOLDEN.minimal.expectedCch);
      expect(extractCch(altered)).not.toBe(GOLDEN.minimal.expectedCch);
    });

    it("changes cch when the cc_version fingerprint changes", async () => {
      const a = buildBody({
        header: "x-anthropic-billing-header: cc_version=2.1.90.aaa; cc_entrypoint=cli; cch=00000;",
      });
      const b = buildBody({
        header: "x-anthropic-billing-header: cc_version=2.1.90.bbb; cc_entrypoint=cli; cch=00000;",
      });
      const signedA = await signSerializedBodyCch(a);
      const signedB = await signSerializedBodyCch(b);
      expect(extractCch(signedA)).not.toBe(extractCch(signedB));
    });

    it("changes cch when system prompt text changes", async () => {
      const a = JSON.stringify({
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;" },
          { type: "text", text: "You are Claude Code." },
        ],
        messages: [{ role: "user", content: "hello" }],
      });
      const b = JSON.stringify({
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;" },
          { type: "text", text: "You are a helpful assistant." },
        ],
        messages: [{ role: "user", content: "hello" }],
      });
      const signedA = await signSerializedBodyCch(a);
      const signedB = await signSerializedBodyCch(b);
      expect(extractCch(signedA)).not.toBe(extractCch(signedB));
    });

    it("changes cch when max_tokens changes", async () => {
      const a = buildBody({ extra: { max_tokens: 4096 } });
      const b = buildBody({ extra: { max_tokens: 8192 } });
      const signedA = await signSerializedBodyCch(a);
      const signedB = await signSerializedBodyCch(b);
      expect(extractCch(signedA)).not.toBe(extractCch(signedB));
    });

    it("changes cch when stream flag changes", async () => {
      const a = buildBody({ extra: { stream: true } });
      const b = buildBody({ extra: { stream: false } });
      const signedA = await signSerializedBodyCch(a);
      const signedB = await signSerializedBodyCch(b);
      expect(extractCch(signedA)).not.toBe(extractCch(signedB));
    });

    it("changes cch when a single byte differs anywhere in the body", async () => {
      const body = GOLDEN.minimal.body;
      const flipped = body.replace("20250514", "20250515");
      expect(flipped).not.toBe(body);
      expect(flipped).toContain("cch=00000");

      const signedBase = await signSerializedBodyCch(body);
      const signedFlipped = await signSerializedBodyCch(flipped);
      expect(extractCch(signedBase)).toBe(GOLDEN.minimal.expectedCch);
      expect(extractCch(signedFlipped)).not.toBe(GOLDEN.minimal.expectedCch);
    });
  });

  describe("placeholder-only replacement", () => {
    it("replaces only the billing header cch, not metadata or user content containing 00000", async () => {
      const body = buildBody({ extra: { metadata: { placeholder: "00000" } } });
      const signed = await signSerializedBodyCch(body);
      expect(signed).not.toContain("cch=00000;");
      expect(signed).toContain('"placeholder":"00000"');
    });

    it("does not modify user message content that mentions cch=00000", async () => {
      const body = JSON.stringify({
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;" },
        ],
        messages: [{ role: "user", content: "The header has cch=00000; in it" }],
      });
      const signed = await signSerializedBodyCch(body);
      // The billing header cch should be signed
      expect(signed).not.toMatch(/"text":"x-anthropic-billing-header:[^"]*cch=00000;"/);
      // But the user message content should still contain the literal text
      expect(signed).toContain("The header has cch=00000; in it");
    });

    it("does not modify assistant message content mentioning the billing header", async () => {
      const body = JSON.stringify({
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000;" },
        ],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "I see a billing header with cch=00000; in the system prompt" },
        ],
      });
      const signed = await signSerializedBodyCch(body);
      expect(signed).toContain("I see a billing header with cch=00000; in the system prompt");
      // Billing header itself was signed (extractCch returns the first match,
      // which is the system block since it appears before messages in JSON).
      expect(extractCch(signed)).not.toBe("00000");
      expect(signed).not.toBe(body);
    });
  });

  describe("regex coverage", () => {
    it("does not match when cch is not the last field before the closing quote", async () => {
      // If cc_workload is added after cch, the current regex requires cch=00000;"
      // (semicolon then quote). A field after cch breaks this assumption.
      // This test documents the current limitation.
      const body = JSON.stringify({
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=00000; cc_workload=batch;",
          },
        ],
        messages: [{ role: "user", content: "hello" }],
      });
      // Current regex does NOT match this — body passes through unsigned.
      const signed = await signSerializedBodyCch(body);
      expect(signed).toBe(body);
      expect(signed).toContain("cch=00000");
    });
  });

  describe("no-op behavior", () => {
    it("returns original body when no placeholder is present", async () => {
      const body = buildBody({
        header: "x-anthropic-billing-header: cc_version=2.1.90.b39; cc_entrypoint=cli; cch=abcde;",
      });
      await expect(signSerializedBodyCch(body)).resolves.toBe(body);
    });

    it("returns original body when billing header is absent entirely", async () => {
      const body = JSON.stringify({
        system: [{ type: "text", text: "You are a helpful assistant." }],
        messages: [{ role: "user", content: "hello" }],
      });
      await expect(signSerializedBodyCch(body)).resolves.toBe(body);
    });

    it("returns original body when system is empty", async () => {
      const body = JSON.stringify({
        system: [],
        messages: [{ role: "user", content: "hello" }],
      });
      await expect(signSerializedBodyCch(body)).resolves.toBe(body);
    });

    it("returns original body when input is empty string", async () => {
      await expect(signSerializedBodyCch("")).resolves.toBe("");
    });

    it("returns original body when input is not valid JSON", async () => {
      const raw = "not json at all";
      await expect(signSerializedBodyCch(raw)).resolves.toBe(raw);
    });
  });

  describe("double-sign prevention", () => {
    it("does not re-sign an already signed body", async () => {
      const body = GOLDEN.minimal.body;
      const signed = await signSerializedBodyCch(body);
      const doubleSigned = await signSerializedBodyCch(signed);
      expect(doubleSigned).toBe(signed);
    });

    it("does not re-sign any of the golden fixtures", async () => {
      for (const fixture of Object.values(GOLDEN)) {
        const signed = await signSerializedBodyCch(fixture.body);
        const doubleSigned = await signSerializedBodyCch(signed);
        expect(doubleSigned).toBe(signed);
      }
    });
  });

  describe("hash input correctness (verified via golden values)", () => {
    it("golden value confirms hash-then-replace ordering (placeholder present during hashing)", async () => {
      // The golden value was computed by hashing the body WITH '00000' in place.
      // If the implementation hashed after replacement, the value would differ.
      // Additionally, double-sign idempotency proves the placeholder is consumed.
      const signed = await signSerializedBodyCch(GOLDEN.minimal.body);
      expect(extractCch(signed)).toBe(GOLDEN.minimal.expectedCch);
      const reSigned = await signSerializedBodyCch(signed);
      expect(reSigned).toBe(signed);
    });

    it("golden value confirms UTF-8 byte encoding for multi-byte characters", async () => {
      // The unicode golden value was computed using TextEncoder (UTF-8).
      // If the implementation used latin1 or another encoding, the hash
      // would differ from the expected value.
      const signed = await signSerializedBodyCch(GOLDEN.unicode.body);
      expect(extractCch(signed)).toBe(GOLDEN.unicode.expectedCch);
    });
  });
});
