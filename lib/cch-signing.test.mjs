import { describe, expect, it } from "vitest";

import { signSerializedBodyCch } from "./cch-signing.mjs";

function buildBody({
  header = "x-anthropic-billing-header: cc_version=2.1.80.abc; cc_entrypoint=cli; cch=00000;",
  suffix = "alpha",
} = {}) {
  return JSON.stringify({
    system: [{ type: "text", text: header }],
    messages: [{ role: "user", content: suffix }],
    metadata: { placeholder: "00000" },
  });
}

function extractCch(serializedBody) {
  return serializedBody.match(/\bcch=([0-9a-f]{5})\b/)?.[1] ?? null;
}

describe("signSerializedBodyCch", () => {
  it("returns the original body when the cch placeholder is absent", async () => {
    const serializedBody = buildBody({
      header: "x-anthropic-billing-header: cc_version=2.1.80.abc; cc_entrypoint=cli; cch=abcde;",
    });

    await expect(signSerializedBodyCch(serializedBody)).resolves.toBe(serializedBody);
  });

  it("returns deterministic output for the same serialized body", async () => {
    const serializedBody = buildBody();

    const first = await signSerializedBodyCch(serializedBody);
    const second = await signSerializedBodyCch(serializedBody);

    expect(first).toBe(second);
  });

  it("changes the signed output when the serialized body changes", async () => {
    const first = await signSerializedBodyCch(buildBody({ suffix: "alpha" }));
    const second = await signSerializedBodyCch(buildBody({ suffix: "omega" }));

    expect(extractCch(first)).toBe("8d88e");
    expect(extractCch(second)).toBe("d1d43");
  });

  it("produces a 5 character lowercase hex cch", async () => {
    const signedBody = await signSerializedBodyCch(buildBody());

    expect(extractCch(signedBody)).toMatch(/^[0-9a-f]{5}$/);
  });

  it("replaces only the cch placeholder occurrence", async () => {
    const serializedBody = buildBody();

    const signedBody = await signSerializedBodyCch(serializedBody);

    expect(signedBody).not.toContain("cch=00000;");
    expect(signedBody).toContain('"placeholder":"00000"');
    expect(signedBody).toContain("cc_entrypoint=cli; cch=");
  });

  it("does not sign a body twice once a cch value is present", async () => {
    const serializedBody = buildBody();

    const first = await signSerializedBodyCch(serializedBody);
    const second = await signSerializedBodyCch(first);

    expect(second).toBe(first);
  });

  it("does not rewrite non-header text that happens to mention cch=00000", async () => {
    const serializedBody = JSON.stringify({
      system: [{ type: "text", text: "Normal system prompt" }],
      messages: [
        {
          role: "user",
          content: "I typed x-anthropic-billing-header: cc_version=2.1.80.abc; cc_entrypoint=cli; cch=00000;",
        },
      ],
    });

    await expect(signSerializedBodyCch(serializedBody)).resolves.toBe(serializedBody);
  });
});
