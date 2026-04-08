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

  it("replaces the newer CLI-tool intro shape", () => {
    const input = `You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\nlegacy body\nYou are powered by the model named claude-opus-4-6`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nYou are powered by the model named claude-opus-4-6`,
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

  it("skips an earlier unmatched start and replaces a later valid start", () => {
    const input = [START, "\nquoted line without an end marker\n", "prefix text\n", START, "\nlegacy body\n", END].join(
      "",
    );

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${START}\nquoted line without an end marker\nprefix text\n${ANTHROPIC_REPLACEMENT_PROMPT}`,
    );
  });

  it("uses the earliest valid boundary across full and fallback end markers", () => {
    const input = `${START}\nlegacy body\nInstructions from: /tmp/example.md\n${SYSTEM_PROMPT_END_MARKERS[1]}`;

    expect(replaceBoundedAnthropicSystemPrompt(input)).toBe(
      `${ANTHROPIC_REPLACEMENT_PROMPT}\nInstructions from: /tmp/example.md\n${SYSTEM_PROMPT_END_MARKERS[1]}`,
    );
  });
});
