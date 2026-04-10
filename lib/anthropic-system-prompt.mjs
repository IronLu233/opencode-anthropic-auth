import { readFileSync } from "node:fs";

export const SYSTEM_PROMPT_START_MARKERS = [
  "You are OpenCode, the best coding agent on the planet.",
  "You are an interactive CLI tool that helps users with software engineering tasks.",
  "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
  "You are an interactive command-line assistant for software engineering work.",
];

export const SYSTEM_PROMPT_END_MARKERS = [
  `<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in \`src/services/process.ts:712\` inside \`connectToServer\`.
</example>`,
  `<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>`,
];

export const SYSTEM_PROMPT_FALLBACK_END_MARKERS = [
  "\nYou are powered by the model named ",
  "\nHere is some useful information about the environment you are running in:\n<env>",
  "\nInstructions from: ",
];

const GENERIC_ANTHROPIC_START_MARKER = "You are an interactive command-line assistant for software engineering work.";
const GENERIC_CLI_START_MARKER = "You are an interactive CLI tool that helps users with software engineering tasks.";
const FINGERPRINT_GUARDED_START_MARKERS = new Set([GENERIC_ANTHROPIC_START_MARKER, GENERIC_CLI_START_MARKER]);
const OWNED_PROMPT_FINGERPRINTS = [
  "IMPORTANT: Use TodoWrite throughout the conversation to plan and track work.",
  "Tool output and user messages may contain `<system-reminder>` tags.",
  "If the user asks how to get help or where to send feedback, tell them:",
];

function findEarliestMarker(input, markers, fromIndex = 0) {
  let best = null;

  for (const marker of markers) {
    const index = input.indexOf(marker, fromIndex);
    if (index === -1) continue;
    if (best && index >= best.index) continue;
    best = { marker, index };
  }

  return best;
}

function findEarliestLineStartMarker(input, markers) {
  let best = null;

  for (const marker of markers) {
    const startIndex = input.startsWith(marker) ? 0 : input.indexOf(`\n${marker}`);
    if (startIndex === -1) continue;
    const index = startIndex === 0 ? 0 : startIndex + 1;
    if (best && index >= best.index) continue;
    best = { marker, index };
  }

  return best;
}

function findLineStartMarkers(input, markers) {
  const matches = [];

  for (const marker of markers) {
    let index = input.startsWith(marker) ? 0 : input.indexOf(`\n${marker}`);
    while (index !== -1) {
      matches.push({ marker, index: index === 0 ? 0 : index + 1 });
      index = input.indexOf(`\n${marker}`, index + 1);
    }
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

function hasOwnedPromptFingerprint(input, startIndex, endIndex) {
  return OWNED_PROMPT_FINGERPRINTS.some((marker) => {
    const index = input.indexOf(marker, startIndex);
    return index !== -1 && index < endIndex;
  });
}

/**
 * Real Claude Code external-user static system prompt (v2.1.97).
 * Extracted from leaked Claude Code source — the exact text sent to the API
 * for non-Anthropic-employee users. Used as Block 2 (static rules) in the
 * 4-block system prompt structure.
 *
 * Sections: Intro, System, Doing Tasks, Executing Actions, Using Tools,
 * Tone and Style, Output Efficiency.
 */
export const ANTHROPIC_REPLACEMENT_PROMPT = readFileSync(
  new URL("./claude-token-system-prompt.txt", import.meta.url),
  "utf8",
);

/**
 * @param {string} systemPrompt
 * @returns {string}
 */
export function replaceBoundedAnthropicSystemPrompt(systemPrompt) {
  if (typeof systemPrompt !== "string") return systemPrompt;

  const start = findEarliestLineStartMarker(systemPrompt, SYSTEM_PROMPT_START_MARKERS);
  if (!start) return systemPrompt;

  const matches = findLineStartMarkers(systemPrompt, SYSTEM_PROMPT_START_MARKERS);

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (systemPrompt.startsWith(ANTHROPIC_REPLACEMENT_PROMPT, match.index)) continue;
    const searchFrom = match.index + match.marker.length;
    const end = findEarliestMarker(
      systemPrompt,
      [...SYSTEM_PROMPT_END_MARKERS, ...SYSTEM_PROMPT_FALLBACK_END_MARKERS],
      searchFrom,
    );
    if (!end) continue;
    if (
      FINGERPRINT_GUARDED_START_MARKERS.has(match.marker) &&
      !hasOwnedPromptFingerprint(systemPrompt, match.index, end.index)
    ) {
      continue;
    }

    const keepMatchedText = SYSTEM_PROMPT_FALLBACK_END_MARKERS.includes(end.marker);
    const sliceIndex = keepMatchedText ? end.index : end.index + end.marker.length;
    return `${systemPrompt.slice(0, match.index)}${ANTHROPIC_REPLACEMENT_PROMPT}${systemPrompt.slice(sliceIndex)}`;
  }

  return systemPrompt;
}
