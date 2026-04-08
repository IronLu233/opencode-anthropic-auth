import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_REPLACEMENT_PROMPT,
  SYSTEM_PROMPT_END_MARKERS,
  replaceBoundedAnthropicSystemPrompt,
} from "./anthropic-system-prompt.mjs";

const START = "You are OpenCode, the best coding agent on the planet.";
const END = SYSTEM_PROMPT_END_MARKERS[0];

describe("replaceBoundedAnthropicSystemPrompt", () => {
  it("replaces the bounded OpenCode segment and preserves surrounding text", () => {
    const input = `prefix text\n${START}\nlegacy body\n${END}\ntrailing text`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `prefix text\n${ANTHROPIC_REPLACEMENT_PROMPT}\ntrailing text`,
    );
  });

  it("returns the original string when the end marker is missing", () => {
    const input = `${START}\nlegacy body\n<example>\npartial tail\n</example>`;
    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(input);
  });

  it("returns the original string when only an inline reminder tag mention exists", () => {
    const input = `${START}\nlegacy body mentions <system-reminder> tags in prose\n${END.replace("</example>", "")}`;
    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(input);
  });

  it("replaces only through the first full end marker when more text follows", () => {
    const extra = `<system-reminder>\nsecond reminder\n</system-reminder>`;
    const input = `${START}\nlegacy body\n${END}\n${extra}`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(`${ANTHROPIC_REPLACEMENT_PROMPT}\n${extra}`);
  });

  it("replaces using the fallback environment marker when no known tail marker exists", () => {
    const input = `${START}\nlegacy body\nYou are powered by the model named claude-opus-4-6`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nYou are powered by the model named claude-opus-4-6`,
    );
  });

  it("replaces the newer CLI-tool intro shape when it carries owned prompt fingerprints", () => {
    const input = [
      "You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.",
      "",
      "IMPORTANT: Use TodoWrite throughout the conversation to plan and track work.",
      "You are powered by the model named claude-opus-4-6",
    ].join("\n");

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nYou are powered by the model named claude-opus-4-6`,
    );
  });

  it("does not replace a generic CLI intro that lacks owned prompt fingerprints", () => {
    const input = [
      "You are an interactive CLI tool that helps users with software engineering tasks.",
      "",
      "Custom user-authored instructions.",
      "Instructions from: local notes",
    ].join("\n");

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(input);
  });

  it("does not replace a generic user-authored prompt that lacks owned Anthropic fingerprints", () => {
    const input = [
      "You are an interactive command-line assistant for software engineering work.",
      "",
      "Custom user-authored instructions.",
      "Instructions from: local notes",
    ].join("\n");

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(input);
  });

  it("does not treat fingerprints after the candidate boundary as owned prompt evidence", () => {
    const input = [
      "You are an interactive command-line assistant for software engineering work.",
      "",
      "Custom user-authored instructions.",
      "Instructions from: local notes",
      "IMPORTANT: Use TodoWrite throughout the conversation to plan and track work.",
    ].join("\n");

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(input);
  });

  it("does not rewrite the plugin-owned replacement prompt again", () => {
    expect(replaceBoundedAnthropicSystemPrompt(ANTHROPIC_REPLACEMENT_PROMPT)).toBe(ANTHROPIC_REPLACEMENT_PROMPT);
  });

  it("still rewrites a later legacy segment when replacement text appears earlier", () => {
    const input = `${ANTHROPIC_REPLACEMENT_PROMPT}\n${START}\nlegacy body\n${END}`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\n${ANTHROPIC_REPLACEMENT_PROMPT}`,
    );
  });

  it("prefers the earliest actual end marker in the prompt", () => {
    const input = `${START}\nlegacy body\n${SYSTEM_PROMPT_END_MARKERS[1]}\nInstructions from: later marker`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nInstructions from: later marker`,
    );
  });

  it("does not match a newer intro when it only appears inside prose", () => {
    const input = `prefix text\nQuoted text: You are an interactive CLI tool that helps users with software engineering tasks.\nInstructions from: later marker`;
    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(input);
  });

  it("replaces using the instructions fallback marker", () => {
    const input = `${START}\nlegacy body\nInstructions from: /tmp/example.md`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nInstructions from: /tmp/example.md`,
    );
  });

  it("replaces the earliest bounded non-leading start even when another start appears later", () => {
    const input = ["prefix text\n", START, "\nquoted line without an end marker\n", START, "\nlegacy body\n", END].join(
      "",
    );

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(`prefix text\n${ANTHROPIC_REPLACEMENT_PROMPT}`);
  });

  it("keeps the leading boundary when a nested later start appears before the end", () => {
    const input = `${START}\nquoted reference:\n${START}\nlegacy body\n${END}`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(ANTHROPIC_REPLACEMENT_PROMPT);
  });

  it("uses the earliest valid boundary across full and fallback end markers", () => {
    const input = `${START}\nlegacy body\nInstructions from: /tmp/example.md\n${SYSTEM_PROMPT_END_MARKERS[1]}`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nInstructions from: /tmp/example.md\n${SYSTEM_PROMPT_END_MARKERS[1]}`,
    );
  });
});
