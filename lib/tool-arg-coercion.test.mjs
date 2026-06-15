import { describe, expect, it } from "vitest";
import { coerceToolArgsInPlace, extractToolInputSchemas } from "./tool-arg-coercion.mjs";

describe("extractToolInputSchemas", () => {
  it("collects tool schemas from request bodies", () => {
    const schemas = extractToolInputSchemas(
      JSON.stringify({
        tools: [
          { name: "bash", input_schema: { type: "object", properties: { timeout: { type: "number" } } } },
          { name: "read", input_schema: { type: "object", properties: { offset: { type: "integer" } } } },
        ],
      }),
    );

    expect(schemas.bash.properties.timeout.type).toBe("number");
    expect(schemas.read.properties.offset.type).toBe("integer");
  });
});

describe("coerceToolArgsInPlace", () => {
  it("coerces safe string mismatches in place", () => {
    const args = {
      command: "pwd",
      timeout: "120000",
      background: "true",
      nested: { retries: "2" },
    };

    const modified = coerceToolArgsInPlace(args, {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        background: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            retries: { type: "integer" },
          },
        },
      },
    });

    expect(modified).toBe(true);
    expect(args.timeout).toBe(120000);
    expect(args.background).toBe(true);
    expect(args.nested.retries).toBe(2);
  });

  it("parses object-shaped strings when the schema expects an object", () => {
    const args = {
      options: '{"head_limit":"5","output_mode":"content"}',
    };

    const modified = coerceToolArgsInPlace(args, {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: {
            head_limit: { type: "integer" },
            output_mode: { type: "string" },
          },
        },
      },
    });

    expect(modified).toBe(true);
    expect(args.options).toEqual({ head_limit: 5, output_mode: "content" });
  });

  it("leaves non-convertible values unchanged", () => {
    const args = { timeout: "120000ms" };

    const modified = coerceToolArgsInPlace(args, {
      type: "object",
      properties: { timeout: { type: "number" } },
    });

    expect(modified).toBe(false);
    expect(args.timeout).toBe("120000ms");
  });

  it("does not coerce when the current string type is already allowed in a union type", () => {
    const args = { timeout: "120000" };

    const modified = coerceToolArgsInPlace(args, {
      type: "object",
      properties: {
        timeout: { type: ["string", "integer"] },
      },
    });

    expect(modified).toBe(false);
    expect(args.timeout).toBe("120000");
  });

  it("does not coerce when anyOf already accepts the current type", () => {
    const args = { timeout: "120000" };

    const modified = coerceToolArgsInPlace(args, {
      type: "object",
      properties: {
        timeout: {
          anyOf: [{ type: "string" }, { type: "integer" }],
        },
      },
    });

    expect(modified).toBe(false);
    expect(args.timeout).toBe("120000");
  });

  it("does not coerce when oneOf already accepts the current type", () => {
    const args = { enabled: "true" };

    const modified = coerceToolArgsInPlace(args, {
      type: "object",
      properties: {
        enabled: {
          oneOf: [{ type: "string" }, { type: "boolean" }],
        },
      },
    });

    expect(modified).toBe(false);
    expect(args.enabled).toBe("true");
  });
});
