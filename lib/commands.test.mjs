import { describe, it, expect } from "vitest";
import {
  resolveCliCommandName,
  resolveSlashCommandName,
  isDestructiveCommand,
  isInteractiveOnlyCommand,
} from "./commands.mjs";

describe("resolveCliCommandName", () => {
  it("resolves canonical commands and aliases", () => {
    expect(resolveCliCommandName("login")).toBe("login");
    expect(resolveCliCommandName("ln")).toBe("login");
    expect(resolveCliCommandName("sw")).toBe("switch");
    expect(resolveCliCommandName("-h")).toBe("help");
  });

  it("returns null for unknown commands", () => {
    expect(resolveCliCommandName("nope")).toBeNull();
  });
});

describe("resolveSlashCommandName", () => {
  it("resolves slash-only aliases", () => {
    expect(resolveSlashCommandName("usage")).toBe("list");
  });

  it("resolves shared aliases", () => {
    expect(resolveSlashCommandName("ra")).toBe("reauth");
    expect(resolveSlashCommandName("mg")).toBe("manage");
  });
});

describe("command metadata helpers", () => {
  it("identifies destructive commands", () => {
    expect(isDestructiveCommand("remove")).toBe(true);
    expect(isDestructiveCommand("logout")).toBe(true);
    expect(isDestructiveCommand("switch")).toBe(false);
  });

  it("identifies interactive-only commands", () => {
    expect(isInteractiveOnlyCommand("manage")).toBe(true);
    expect(isInteractiveOnlyCommand("list")).toBe(false);
  });
});
