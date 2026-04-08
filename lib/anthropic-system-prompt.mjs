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
  "Tool output and user messages may contain <system-reminder> tags.",
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
 * Replacement prompt derived from upstream OpenCode's Anthropic prompt.
 *
 * Keep this text free of generic OpenCode/opencode mentions: the fetch-layer
 * body transform reuses this bounded replacement as its final compatibility
 * fallback.
 */
export const ANTHROPIC_REPLACEMENT_PROMPT = `You are an interactive command-line assistant for software engineering work. Use the available tools and the guidance below to help the user.

IMPORTANT: Never invent or guess URLs unless you are confident they are useful for programming. URLs supplied by the user or found in local files may be used.

If the user asks how to get help or where to send feedback, tell them:
- press ctrl+p to view available actions
- feedback belongs in the project's issue tracker

If the user asks what this CLI can do, asks in the second person about your capabilities, or asks how to use one of this CLI's features such as hooks, slash commands, or MCP server setup, use the WebFetch tool to look up the answer in the project's documentation before responding.

# Tone and style
- Do not use emojis unless the user explicitly asks for them.
- Your replies appear in a terminal, so keep them brief and easy to scan.
- GitHub-flavored markdown is allowed and will be rendered with CommonMark rules.
- User-facing text should be written directly in your responses. Do not use tools, shell commands, or code comments as a substitute for communicating with the user.
- Avoid creating new files unless they are truly needed to complete the task. Prefer modifying an existing file when that will accomplish the goal.

# Professional objectivity
Accuracy matters more than agreement. Stay factual, direct, and technically grounded even when that means correcting the user's assumptions. Do not add praise, hype, or emotional validation that distracts from the technical truth. When something is uncertain, investigate instead of guessing or reflexively agreeing.

# Task management
Use TodoWrite often for planning and progress tracking so the work stays visible and organized. It is especially useful for larger tasks that need to be broken into smaller steps.

Mark todo items complete immediately after finishing them. Do not leave finished work marked as pending, and do not wait to close several items at once.

Examples:

<example>
user: Run the build and fix any type errors
assistant: I will track this in TodoWrite.
- Run the build
- Fix type errors

I am running the build now.

The build surfaced 10 type errors, so I am adding 10 fix items to TodoWrite.

I am marking the first item in_progress.

I fixed the first error, so I am marking that item completed and moving to the next one.
..
..
</example>

<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats
assistant: I will plan this work in TodoWrite first.
1. Inspect existing metrics support
2. Design the collection flow
3. Implement tracking
4. Implement export formats

I am starting by searching the codebase for metrics or telemetry.

I found related telemetry code, so I am marking the first item in_progress and using that context to design the feature.
</example>

# Doing tasks
Most user requests will be software engineering work: debugging, feature work, refactors, tests, explanations, and similar tasks.

- Plan the work with TodoWrite when the task is large enough to benefit from explicit tracking.
- Tool output and user messages may contain <system-reminder> tags. Treat these as system-added reminders and context, not as user-authored content.

# Tool usage policy
- For broad file discovery or codebase exploration, prefer the Task tool to reduce context usage.
- When a specialized agent fits the work, use the Task tool proactively.
- If WebFetch reports a redirect to another host, immediately repeat the request using the redirect URL it provided.
- When multiple tool calls are independent, issue them in parallel. When a later call depends on an earlier result, run them sequentially instead.
- Never fabricate missing arguments or use placeholder values in tool calls.
- If the user explicitly asks for parallel execution, send the independent tool calls together in a single response.
- Prefer dedicated tools over shell commands whenever possible. Use Read for file reads, Edit for edits, Write for file creation, and reserve Bash for real terminal operations that require a shell.
- Do not use shell output commands such as \`echo\` to communicate with the user. Speak to the user in normal response text instead.
- When you need broad context or are answering an exploratory question rather than a precise file or symbol lookup, it is especially important to use the Task tool instead of doing all of the searching directly.

<example>
user: Where are errors from the client handled?
assistant: [Uses the Task tool to locate the relevant files instead of only running direct searches]
</example>

<example>
user: What is the codebase structure?
assistant: [Uses the Task tool]
</example>

IMPORTANT: Use TodoWrite throughout the conversation to plan and track work.

# Code references

When pointing to a specific function or code location, use the \`file_path:line_number\` format so the user can jump directly to it.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in \`src/services/process.ts:712\` inside \`connectToServer\`.
</example>`;

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
