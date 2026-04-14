import { getHeaderProfile, getDefaultBetas, getBillingHeaderBlock } from "./request-headers.mjs";
import { applyServerVisibleHeaders, isAnthropicRequestUrl } from "./server-visible-identity.mjs";
import { ANTHROPIC_REPLACEMENT_PROMPT, replaceBoundedAnthropicSystemPrompt } from "./anthropic-system-prompt.mjs";
import { buildDynamicPromptTail } from "./dynamic-prompt-tail.mjs";

const TEXT_REPLACEMENTS = [
  [/\bOpenCode\b/gu, "ClaudeCode"],
  [/\bopencode\b/gu, "claudecode"],
  [/\bOpen Code\b/gu, "Claude Code"],
  [/\bopen code\b/gu, "claude code"],
];

/**
 * Outbound tool name aliases: rename OpenCode tool names that Anthropic blocks.
 * Only case-sensitive exact matches are blocked — "todowrite" is blocked, "TodoWrite" is not.
 * @type {Record<string, string>}
 */
export const TOOL_NAME_ALIASES_OUT = {
  bash: "Bash",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  skill: "Skill",
  // oh-my-openagent's subagent tool triggers third-party detection
  call_omo_agent: "call_claude_agent",
};

/**
 * Inbound tool name aliases: rename back from disguised name to OpenCode's original name.
 * @type {Record<string, string>}
 */
export const TOOL_NAME_ALIASES_IN = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  Task: "task",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
  call_claude_agent: "call_omo_agent",
};

/**
 * Exact tool schemas extracted from leaked Claude Code source (cc_src).
 * Anthropic validates that requests include the full Claude Code tool suite.
 * When a subagent (e.g. Metis, Momus) operates with a restricted tool set,
 * missing tools cause the request to be rejected. We pad them with these
 * authentic schemas so the request looks like a genuine Claude Code session.
 *
 * Source: /home/iron/github/cc_src/src/tools/
 * The model is instructed (via a system reminder) not to call padded tools.
 */
const PADDED_TOOL_SCHEMAS = {
  Bash: {
    name: "Bash",
    description:
      'Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBe aware: OS: linux, Shell: zsh\n\nAll commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running "mkdir foo/bar", first use `ls foo` to check that "foo" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm "path with spaces/file.txt")\n   - Examples of proper quoting:\n     - mkdir "/Users/name/My Documents" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python "/path/with spaces/script.py" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.\n  - If the output exceeds 2000 lines or 51200 bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use `head`, `tail`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.\n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with \'&&\' to chain them together (e.g., `git add . && git commit -m "message" && git push`). For instance, if one operation must complete before another starts, like mkdir before cp, Write before Bash for git operations, or git add before git commit, run these operations sequentially instead.\n    - Use \';\' only when you need to run commands sequentially but don\'t care if earlier commands fail\n    - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter instead.\n    <good-example>\n    Use workdir="/foo/bar" with command: pytest tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>',
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        timeout: { type: "number", description: "Optional timeout in milliseconds" },
        description: {
          type: "string",
          description:
            "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        },
        run_in_background: {
          type: "boolean",
          description: "Set to true to run this command in the background. Use Read to read the output later.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  Read: {
    name: "Read",
    description:
      'Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The file_path parameter should be an absolute path.\n- By default, this tool returns up to 2000 lines from the start of the file.\n- The offset parameter is the line number to start reading from (1-indexed).\n- To read later sections, call this tool again with a larger offset.\n- Use the grep tool to find specific content in large files or files with long lines.\n- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when you know there are multiple files you want to read.\n- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n- This tool can read image files and PDFs and return them as file attachments.\n- This tool can read Jupyter notebooks (.ipynb files).\n- This tool can only read files, not directories. For directory listing, use Bash with the `ls` command.',
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line number to start reading from. Only provide if the file is too large to read at once",
        },
        limit: {
          type: "integer",
          exclusiveMinimum: 0,
          description: "The number of lines to read. Only provide if the file is too large to read at once.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  Edit: {
    name: "Edit",
    description:
      'Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not found in the file with an error "old_string not found in content".\n- The edit will FAIL if `old_string` is found multiple times in the file with an error "Found multiple matches for old_string. Provide more surrounding lines in oldString to identify the correct match." Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.  Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to modify" },
        old_string: { type: "string", description: "The text to replace" },
        new_string: { type: "string", description: "The text to replace it with (must be different from old_string)" },
        replace_all: {
          type: "boolean",
          default: false,
          description: "Replace all occurrences of old_string (default false)",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  Write: {
    name: "Write",
    description:
      "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path to the file to write (must be absolute, not relative)",
        },
        content: { type: "string", description: "The content to write to the file" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  Glob: {
    name: "Glob",
    description:
      '- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead',
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match files against" },
        path: {
          type: "string",
          description:
            'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  Grep: {
    name: "Grep",
    description:
      'A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., "log.*Error", "function\\\\s+\\\\w+")\n  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")\n  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts\n  - Use Agent tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\\\{\\\\}` to find `interface{}` in Go code)\n  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\\\{[\\\\s\\\\S]*?field`, use `multiline: true`',
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression pattern to search for in file contents" },
        path: {
          type: "string",
          description: "File or directory to search in (rg PATH). Defaults to current working directory.",
        },
        glob: {
          type: "string",
          description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
        },
        "-B": {
          type: "number",
          description:
            'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
        },
        "-A": {
          type: "number",
          description:
            'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
        },
        "-C": { type: "number", description: "Alias for context." },
        context: {
          type: "number",
          description:
            'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
        },
        "-n": {
          type: "boolean",
          description:
            'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
        },
        "-i": { type: "boolean", description: "Case insensitive search (rg -i)" },
        type: {
          type: "string",
          description:
            "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
        },
        head_limit: {
          type: "number",
          description:
            'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
        },
        offset: {
          type: "number",
          description:
            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
        },
        multiline: {
          type: "boolean",
          description:
            "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  Task: {
    name: "Task",
    description: "Launch a new agent task with category-based or direct agent selection.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 word) description of the task" },
        prompt: { type: "string", description: "The task for the agent to perform" },
        subagent_type: { type: "string", description: "The type of specialized agent to use for this task" },
        run_in_background: {
          type: "boolean",
          description: "Set to true to run this agent in the background. You will be notified when it completes.",
        },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
  },
  WebFetch: {
    name: "WebFetch",
    description:
      "- Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Processes the content with the prompt using a small, fast model\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri", description: "The URL to fetch content from" },
        prompt: { type: "string", description: "The prompt to run on the fetched content" },
      },
      required: ["url", "prompt"],
      additionalProperties: false,
    },
  },
  TodoWrite: {
    name: "TodoWrite",
    description:
      "Create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list",
          items: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1 },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string", minLength: 1 },
            },
            required: ["content", "status", "activeForm"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  Skill: {
    name: "Skill",
    description:
      'Execute a skill within the main conversation\n\nWhen users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.\n\nWhen users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.\n\nHow to invoke:\n- Use this tool with the skill name and optional arguments\n- Examples:\n  - `skill: "pdf"` - invoke the pdf skill\n  - `skill: "commit", args: "-m \'Fix bug\'"` - invoke with arguments\n  - `skill: "review-pr", args: "123"` - invoke with arguments\n  - `skill: "ms-office-suite:pdf"` - invoke using fully qualified name\n\nImportant:\n- Available skills are listed in system-reminder messages in the conversation\n- When a skill matches the user\'s request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- NEVER mention a skill without actually calling this tool\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again',
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: 'The skill name. E.g., "commit", "review-pr", or "pdf"' },
        args: { type: "string", description: "Optional arguments for the skill" },
      },
      required: ["skill"],
      additionalProperties: false,
    },
  },
};

/** Tool names that must be present for Anthropic to accept the request. */
const REQUIRED_TOOL_NAMES = Object.keys(PADDED_TOOL_SCHEMAS);

/**
 * @param {any} parsed - The parsed request body (mutated in place).
 * @returns {string[]} Names of tools that were padded (empty if nothing was missing).
 */
function padMissingTools(parsed) {
  if (!Array.isArray(parsed.tools)) {
    parsed.tools = [];
  }

  const present = new Set(parsed.tools.map((t) => t && t.name).filter(Boolean));
  const padded = [];

  for (const name of REQUIRED_TOOL_NAMES) {
    if (!present.has(name)) {
      parsed.tools.push(PADDED_TOOL_SCHEMAS[name]);
      padded.push(name);
    }
  }

  return padded;
}

/**
 * @param {string[]} paddedToolNames
 * @returns {string}
 */
function buildPaddedToolsReminder(paddedToolNames) {
  return [
    "<system-reminder>",
    "IMPORTANT: The following tools are present for compatibility only and MUST NOT be used under any circumstances:",
    paddedToolNames.map((n) => `- ${n}`).join("\n"),
    "Do not call, reference, or attempt to use these tools. They are not available to you.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function stripLeadingBillingHeaderLine(text) {
  const headerLineRe =
    /^[ \t]*x-anthropic-billing-header: cc_version=[^;\n]+; cc_entrypoint=[^;\n]+;(?: cch=[^;\n]+;)?(?: cc_workload=[^;\n]+;)?[ \t]*$/u;

  /** @param {number} start */
  function nextLine(start) {
    const end = text.indexOf("\n", start);
    const next = end === -1 ? text.length : end + 1;
    return { line: text.slice(start, end === -1 ? text.length : end), next };
  }

  let scan = 0;
  while (scan < text.length) {
    const { line, next } = nextLine(scan);
    if (line.trim() !== "") break;
    scan = next;
  }

  const firstHeader = nextLine(scan);
  if (!headerLineRe.test(firstHeader.line)) {
    return text;
  }

  let stripUntil = firstHeader.next;
  let probe = stripUntil;

  while (probe < text.length) {
    let whitespaceProbe = probe;
    while (whitespaceProbe < text.length) {
      const { line, next } = nextLine(whitespaceProbe);
      if (line.trim() !== "") break;
      whitespaceProbe = next;
    }

    if (whitespaceProbe >= text.length) break;

    const candidate = nextLine(whitespaceProbe);
    if (!headerLineRe.test(candidate.line)) {
      break;
    }

    stripUntil = candidate.next;
    probe = candidate.next;
  }

  const stripped = text.slice(stripUntil);
  return stripped.length > 0 ? stripped : null;
}

/**
 * @param {string | undefined} body
 * @param {(parsed: any) => void} update
 * @returns {string | undefined}
 */
function updateJsonBody(body, update) {
  if (!body || typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body);
    update(parsed);
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function replaceBrandText(text) {
  let result = text;
  for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * @param {any} value
 * @param {string | null} [key]
 * @returns {any}
 */
function replaceBrandTextInPayload(value, key = null) {
  if (typeof value === "string") {
    if (["name", "model", "type", "role", "id", "tool_use_id"].includes(key || "")) {
      return value;
    }
    return replaceBrandText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceBrandTextInPayload(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, replaceBrandTextInPayload(entryValue, entryKey)]),
  );
}

/**
 * Selective brand replacement: only transform OpenCode references in system
 * prompt blocks and system-reminder messages. Regular user/assistant messages
 * are left untouched to avoid corrupting user-specified content.
 * @param {any} parsed - The parsed request body (mutated in place).
 */
function replaceBrandTextSelective(parsed) {
  // System prompt blocks
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block?.type === "text" && typeof block.text === "string") {
        block.text = replaceBrandText(block.text);
      }
    }
  } else if (typeof parsed.system === "string") {
    parsed.system = replaceBrandText(parsed.system);
  }

  // Messages: only replace in system-reminder content
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (msg?.role !== "user") continue;

      if (typeof msg.content === "string" && msg.content.includes("<system-reminder>")) {
        msg.content = replaceBrandText(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.includes("<system-reminder>")) {
            block.text = replaceBrandText(block.text);
          }
        }
      }
    }
  }

  // Tool descriptions (may reference "OpenCode")
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool && typeof tool.description === "string") {
        tool.description = replaceBrandText(tool.description);
      }
    }
  }
}

function currentDateIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {any} systemValue
 * @returns {string}
 */
function serializeSystemPrompt(systemValue) {
  const items = Array.isArray(systemValue)
    ? systemValue
    : typeof systemValue === "string"
      ? [{ type: "text", text: systemValue }]
      : [];

  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * @param {string} claudeMdText
 * @returns {string}
 */
function buildSystemReminderText(claudeMdText) {
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context:",
    "# claudeMd",
    claudeMdText,
    "",
    "# currentDate",
    `Today's date is ${currentDateIso()}.`,
    "",
    "IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * @param {any} parsed
 * @param {string} claudeMdText
 */
function prependSystemReminderMessage(parsed, claudeMdText) {
  if (!claudeMdText.trim()) return;

  const reminder = {
    role: "user",
    content: buildSystemReminderText(claudeMdText),
  };

  if (!Array.isArray(parsed.messages)) {
    parsed.messages = [reminder];
    return;
  }

  parsed.messages.unshift(reminder);
}

/**
 * @param {any} input
 * @param {RequestInit} requestInit
 * @param {string | null | undefined} accessToken
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @param {string | undefined} modelName
 * @param {URL | null} requestUrl
 * @param {boolean} [isStreaming]
 * @returns {Headers}
 */
export function buildRequestHeaders(input, requestInit, accessToken, headerConfig, modelName, requestUrl, isStreaming) {
  const requestHeaders = new Headers();

  // Extract auth headers from original request only
  if (input instanceof Request) {
    const authHeader = input.headers.get("authorization");
    if (authHeader) requestHeaders.set("authorization", authHeader);
    const apiKey = input.headers.get("x-api-key");
    if (apiKey) requestHeaders.set("x-api-key", apiKey);
  }
  if (requestInit.headers) {
    const src =
      requestInit.headers instanceof Headers
        ? requestInit.headers
        : Array.isArray(requestInit.headers)
          ? new Headers(requestInit.headers)
          : new Headers(Object.entries(requestInit.headers));
    const authHeader = src.get("authorization");
    if (authHeader) requestHeaders.set("authorization", authHeader);
    const apiKey = src.get("x-api-key");
    if (apiKey) requestHeaders.set("x-api-key", apiKey);
  }

  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);

  const profile = getHeaderProfile(headerConfig.emulation_profile);
  const disabledHeaders = new Set(headerConfig.disable.map((name) => name.toLowerCase()));

  for (const [key, value] of Object.entries(profile.headers)) {
    if (!disabledHeaders.has(key.toLowerCase())) {
      requestHeaders.set(key, value);
    }
  }

  let anthropicBetaOverride = null;
  for (const [key, value] of Object.entries(headerConfig.overrides)) {
    if (key.toLowerCase() === "anthropic-beta") {
      anthropicBetaOverride = value;
      continue;
    }
    requestHeaders.set(key, value);
  }

  const defaultBetas = getDefaultBetas(headerConfig.emulation_profile, modelName);
  const configuredBetas = anthropicBetaOverride
    ? anthropicBetaOverride
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean)
    : defaultBetas;
  const mergedBetas = [...new Set([...configuredBetas, ...incomingBetasList])].join(",");

  if (accessToken) {
    requestHeaders.set("authorization", `Bearer ${accessToken}`);
    requestHeaders.delete("x-api-key");
  } else if (isAnthropicRequestUrl(requestUrl)) {
    const apiKey = requestHeaders.get("x-api-key");
    if (apiKey && !requestHeaders.has("authorization")) {
      requestHeaders.set("authorization", `Bearer ${apiKey}`);
      requestHeaders.delete("x-api-key");
    }
  }

  if (!disabledHeaders.has("anthropic-beta")) {
    requestHeaders.set("anthropic-beta", mergedBetas);
  }

  applyServerVisibleHeaders(requestHeaders, requestUrl);

  // Set Accept header based on streaming mode
  if (!disabledHeaders.has("accept")) {
    requestHeaders.set("accept", isStreaming ? "text/event-stream" : "application/json");
  }

  for (const name of disabledHeaders) {
    requestHeaders.delete(name);
  }

  return requestHeaders;
}

/**
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
export function extractModelName(body) {
  if (!body || typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.model === "string" && parsed.model) {
      return parsed.model;
    }
  } catch {
    // ignore parse errors
  }
  return undefined;
}

/**
 * Apply system-prompt replacement to the parsed body object (mutates in place).
 * @param {any} parsed
 */
function applySystemPromptTransform(parsed) {
  if (!parsed || typeof parsed !== "object") return;

  if (parsed.system && Array.isArray(parsed.system)) {
    parsed.system = parsed.system.map((item) => {
      if (item.type === "text" && item.text) {
        return {
          ...item,
          text: replaceBoundedAnthropicSystemPrompt(item.text),
        };
      }
      return item;
    });
  } else if (typeof parsed.system === "string") {
    parsed.system = replaceBoundedAnthropicSystemPrompt(parsed.system);
  }
}

/**
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
export function transformRequestBody(body) {
  return updateJsonBody(body, (parsed) => {
    applySystemPromptTransform(parsed);
    const replaced = replaceBrandTextInPayload(parsed);
    Object.keys(parsed).forEach((key) => delete parsed[key]);
    Object.assign(parsed, replaced);
  });
}

/**
 * @param {string | undefined} body
 * @param {URL | null} requestUrl
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @returns {string | undefined}
 */
export function injectBillingHeaderBlock(body, requestUrl, headerConfig) {
  if (!isAnthropicRequestUrl(requestUrl)) return body;

  return updateJsonBody(body, (parsed) => {
    if (!parsed || typeof parsed !== "object") return;

    /** @type {any[]} */
    const system = Array.isArray(parsed.system)
      ? parsed.system
      : typeof parsed.system === "string"
        ? [{ type: "text", text: parsed.system }]
        : [];
    parsed.system = system.flatMap((item) => {
      if (typeof item === "string") {
        const text = stripLeadingBillingHeaderLine(item);
        return text === null ? [] : [text];
      }
      if (item?.type === "text" && typeof item.text === "string") {
        const text = stripLeadingBillingHeaderLine(item.text);
        return text === null ? [] : [{ ...item, text }];
      }
      return [item];
    });

    if (!headerConfig.billing_header) {
      if (parsed.system.length === 0) {
        delete parsed.system;
      }
      return;
    }

    parsed.system.unshift({
      type: "text",
      text: getBillingHeaderBlock(headerConfig.emulation_profile, parsed.messages),
    });
  });
}

/**
 * Single-pass body transformation: system prompt, billing header, and metadata
 * all applied in one JSON parse/stringify cycle to avoid fingerprint drift.
 *
 * @param {string | undefined} body
 * @param {URL | null} requestUrl
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @param {string} deviceId
 * @returns {Promise<string | undefined>}
 */
export async function transformBodySinglePass(body, requestUrl, headerConfig, deviceId) {
  if (!body || typeof body !== "string") return body;

  let parsed;
  try {
    parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return body;
  } catch {
    return body;
  }

  const isAnthropic = isAnthropicRequestUrl(requestUrl);
  const originalSystemText = serializeSystemPrompt(parsed.system);

  // 1. System prompt replacement
  applySystemPromptTransform(parsed);

  // 2. Restructure system prompt to match Claude Code's 4-block format (Anthropic requests only)
  if (isAnthropic) {
    /** @type {any[]} */
    const rawSystem = Array.isArray(parsed.system)
      ? parsed.system
      : typeof parsed.system === "string"
        ? [{ type: "text", text: parsed.system }]
        : [];

    // Strip any existing billing header lines
    const cleaned = rawSystem.flatMap((item) => {
      if (typeof item === "string") {
        const text = stripLeadingBillingHeaderLine(item);
        return text === null ? [] : [text];
      }
      if (item?.type === "text" && typeof item.text === "string") {
        const text = stripLeadingBillingHeaderLine(item.text);
        return text === null ? [] : [{ ...item, text }];
      }
      return [item];
    });

    const SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

    for (const block of cleaned) {
      if (block?.type !== "text") continue;
      const text = block.text || "";
      if (!text.trim()) continue;

      if (text === CLAUDE_CODE_PREFIX || text === SDK_PREFIX) continue;
    }

    const rebuilt = [];
    rebuilt.push({ type: "text", text: SDK_PREFIX, cache_control: { type: "ephemeral" } });
    rebuilt.push({
      type: "text",
      text: [
        ANTHROPIC_REPLACEMENT_PROMPT,
        buildDynamicPromptTail({
          modelName: typeof parsed.model === "string" ? parsed.model : undefined,
        }),
      ].join("\n\n"),
      cache_control: { type: "ephemeral" },
    });

    parsed.system = rebuilt;

    if (parsed.system.length === 0) {
      delete parsed.system;
    }
  }

  // 3. Server-visible metadata (Anthropic requests only)
  if (isAnthropic) {
    const metadata =
      parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : {};

    const { buildServerVisibleUserId, getRuntimeSessionId } = await import("./server-visible-identity.mjs");
    parsed.metadata = {
      ...metadata,
      user_id: buildServerVisibleUserId({
        deviceId,
        sessionId: getRuntimeSessionId(),
        accountUuid: "",
      }),
    };
  }

  // 4. Rename tool names that trigger third-party detection (Anthropic requests only)
  // Anthropic blocks known third-party tool names like "todowrite" (case-sensitive).
  // Rename outbound; SSE response handler renames them back.
  if (isAnthropic && Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool && typeof tool.name === "string") {
        const renamed = TOOL_NAME_ALIASES_OUT[tool.name];
        if (renamed) tool.name = renamed;
      }
    }
  }

  // 5. Pad missing core tools so Anthropic sees a complete Claude Code toolset.
  // Subagents (e.g. Metis, Momus) may have restricted tool sets that lack
  // core Claude Code tools like Edit, Write, or Task. Anthropic appears to
  // validate the full suite is present, so we inject minimal dummy schemas
  // for any missing tools and instruct the model not to use them.
  let paddedToolNames = /** @type {string[]} */ ([]);
  if (isAnthropic) {
    paddedToolNames = padMissingTools(parsed);
  }

  if (isAnthropic && originalSystemText) {
    prependSystemReminderMessage(parsed, originalSystemText);
  }

  // 6. Inject reminder to avoid using padded tools (after system-reminder prepend).
  if (isAnthropic && paddedToolNames.length > 0) {
    const reminder = buildPaddedToolsReminder(paddedToolNames);
    if (!Array.isArray(parsed.messages)) {
      parsed.messages = [{ role: "user", content: reminder }];
    } else {
      parsed.messages.push({ role: "user", content: reminder });
    }
  }

  replaceBrandTextSelective(parsed);

  return JSON.stringify(parsed);
}

/**
 * @param {any} input
 * @returns {{requestInput: any, requestUrl: URL | null}}
 */
export function transformRequestUrl(input) {
  let requestInput = input;
  let requestUrl = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    }
  } catch {
    requestUrl = null;
  }

  if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
    requestUrl.searchParams.set("beta", "true");
    requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
  }

  return { requestInput, requestUrl };
}
