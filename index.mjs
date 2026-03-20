import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AccountManager } from "./lib/accounts.mjs";
import { main as cliMain } from "./cli.mjs";
import { authorize, exchange } from "./lib/oauth.mjs";
import { loadConfig } from "./lib/config.mjs";
import { loadAccounts, saveAndSync, clearAccounts, hasAccountsStorageFile } from "./lib/storage.mjs";
import {
  adjustActiveIndexAfterRemoval,
  applyLoginCredentials,
  applyReauthCredentials,
  ensureAccountStorage,
} from "./lib/account-state.mjs";
import { resolveSlashCommandName, isDestructiveCommand, isInteractiveOnlyCommand } from "./lib/commands.mjs";
import { isAccountSpecificError, parseRateLimitReason, parseRetryAfterHeader } from "./lib/backoff.mjs";
import { getBillingHeaderBlock } from "./lib/request-headers.mjs";
import {
  buildRequestHeaders,
  extractModelName,
  transformRequestBody,
  transformRequestUrl,
} from "./lib/request-transform.mjs";
import { isEventStreamResponse, transformResponse } from "./lib/sse-stream.mjs";
import {
  readDiskAccountAuth,
  markTokenStateUpdated,
  applyDiskAuthIfFresher,
  refreshAccountToken,
} from "./lib/token-refresh.mjs";
import {
  clearOpenCodeAuth,
  getOpenCodeAuth,
  getOpenCodeSyncAccount,
  setOpenCodeAuth,
  syncOpenCodeAuthFromStorage,
} from "./lib/opencode-auth.mjs";
import { stripAnsi } from "./lib/util.mjs";

// ---------------------------------------------------------------------------
// Account management CLI prompts
// ---------------------------------------------------------------------------

/**
 * @param {import('./lib/accounts.mjs').AccountManager} accountManager
 * @returns {Promise<'add' | 'fresh' | 'manage' | 'cancel'>}
 */
async function promptAccountMenu(accountManager) {
  const accounts = accountManager.getAccountsSnapshot();
  const currentIndex = accountManager.getCurrentIndex();
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(`\n${accounts.length} account(s) configured:`);
    for (const acc of accounts) {
      const name = acc.email || `Account ${acc.index + 1}`;
      const active = acc.index === currentIndex ? " (active)" : "";
      const disabled = !acc.enabled ? " [disabled]" : "";
      console.log(`  ${acc.index + 1}. ${name}${active}${disabled}`);
    }
    console.log("");

    while (true) {
      const answer = await rl.question("(a)dd new, (f)resh start, (m)anage, (c)ancel? [a/f/m/c]: ");
      const normalized = answer.trim().toLowerCase();
      if (normalized === "a" || normalized === "add") return "add";
      if (normalized === "f" || normalized === "fresh") return "fresh";
      if (normalized === "m" || normalized === "manage") return "manage";
      if (normalized === "c" || normalized === "cancel") return "cancel";
      console.log("Please enter 'a', 'f', 'm', or 'c'.");
    }
  } finally {
    rl.close();
  }
}

/**
 * @param {import('./lib/accounts.mjs').AccountManager} accountManager
 * @returns {Promise<void>}
 */
async function promptManageAccounts(accountManager) {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const stored = await loadAccounts();
      const accounts = stored?.accounts || accountManager.getAccountsSnapshot();
      const currentIndex = stored?.activeIndex ?? accountManager.getCurrentIndex();

      console.log("\nManage accounts:");
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        const name = acc.email || `Account ${i + 1}`;
        const status = acc.enabled ? "enabled" : "disabled";
        const active = i === currentIndex ? " (active)" : "";
        console.log(`  ${i + 1}. ${name} [${status}]${active}`);
      }
      console.log("");

      const answer = await rl.question("Enter account number to toggle, (d)N to delete (e.g. d1), or (b)ack: ");
      const normalized = answer.trim().toLowerCase();

      if (normalized === "b" || normalized === "back") return;

      // Delete: d1, d2, etc.
      const deleteMatch = normalized.match(/^d(\d+)$/);
      if (deleteMatch) {
        const idx = parseInt(deleteMatch[1], 10) - 1;
        if (idx >= 0 && idx < accounts.length) {
          if (!stored) {
            console.log("Cannot modify accounts: storage unavailable.");
            continue;
          }
          stored.accounts.splice(idx, 1);
          adjustActiveIndexAfterRemoval(stored, idx);
          await saveAndSync(stored);
          console.log(`Removed account ${idx + 1}.`);
          return;
        }
        console.log("Invalid account number.");
        continue;
      }

      // Toggle: just the number
      const num = parseInt(normalized, 10);
      if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        const account = accounts[num - 1];
        const wasEnabled = account.enabled;
        const enabledCount = accounts.filter((entry) => entry.enabled).length;
        if (account.enabled && enabledCount <= 1) {
          console.log("Cannot disable the last enabled account.");
          continue;
        }
        if (!stored) {
          console.log("Cannot modify accounts: storage unavailable.");
          continue;
        }
        stored.accounts[num - 1].enabled = !stored.accounts[num - 1].enabled;
        if (!stored.accounts[num - 1].enabled && stored.activeIndex === num - 1) {
          const nextEnabled = stored.accounts.findIndex((entry, index) => entry.enabled && index !== num - 1);
          if (nextEnabled >= 0) stored.activeIndex = nextEnabled;
        }
        await saveAndSync(stored);
        console.log(`Account ${num} is now ${wasEnabled ? "disabled" : "enabled"}.`);
        continue;
      }

      console.log("Invalid input.");
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Request building helpers (extracted from original fetch interceptor)
// ---------------------------------------------------------------------------

/**
 * Build user-facing switch reason text for account-specific errors.
 * @param {number} status
 * @param {import('./lib/backoff.mjs').RateLimitReason} reason
 * @returns {string}
 */
function formatSwitchReason(status, reason) {
  if (reason === "AUTH_FAILED") return "auth failed";
  if (status === 403 && reason === "QUOTA_EXHAUSTED") return "permission denied";
  if (reason === "QUOTA_EXHAUSTED") return "quota exhausted";
  return "rate-limited";
}

/**
 * Format a duration into a compact human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDurationShort(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.ceil(hours / 24);
  return `${days}d`;
}

/**
 * Build a diagnostic reason when no account can be selected.
 * @param {import('./lib/accounts.mjs').AccountManager} accountManager
 * @param {Set<number>} transientRefreshSkips
 * @param {unknown} lastError
 * @returns {string}
 */
function buildNoAvailableAccountReason(accountManager, transientRefreshSkips, lastError) {
  const now = Date.now();
  const accounts = accountManager.getAccountsSnapshot();
  const enabled = accounts.filter((acc) => acc.enabled);

  if (enabled.length === 0) {
    return "no enabled accounts";
  }

  const transientFailures = enabled.filter((acc) => transientRefreshSkips.has(acc.index));
  const rateLimited = enabled
    .map((acc) => ({ acc, resetAt: acc.rateLimitResetTimes?.anthropic }))
    .filter(
      ({ acc, resetAt }) => !transientRefreshSkips.has(acc.index) && typeof resetAt === "number" && resetAt > now,
    );

  const parts = [];

  if (rateLimited.length > 0) {
    const nextResetMs = Math.min(...rateLimited.map(({ resetAt }) => resetAt - now));
    parts.push(`${rateLimited.length} rate-limited (next retry in ${formatDurationShort(nextResetMs)})`);
  }

  if (transientFailures.length > 0) {
    parts.push(`${transientFailures.length} temporarily unavailable (request failures)`);
  }

  const unclassifiedCount = enabled.length - rateLimited.length - transientFailures.length;
  if (unclassifiedCount > 0) {
    parts.push(`${unclassifiedCount} unavailable (unknown reason)`);
  }

  if (lastError instanceof Error && lastError.message) {
    const compact = lastError.message.replace(/\s+/g, " ").trim();
    if (compact) {
      const snippet = compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
      parts.push(`last error: ${snippet}`);
    }
  }

  return parts.join("; ") || "all enabled accounts unavailable";
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const ANTHROPIC_COMMAND_HANDLED = "__ANTHROPIC_COMMAND_HANDLED__";
const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

/**
 * Parse command arguments with minimal quote support.
 *
 * Examples:
 *   a b "c d"  -> ["a", "b", "c d"]
 *   a 'c d'     -> ["a", "c d"]
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseCommandArgs(raw) {
  if (!raw || !raw.trim()) return [];
  const parts = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    parts.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return parts;
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  const config = loadConfig();

  // Hydrate OpenCode's auth.json from existing plugin accounts so that
  // CLI-only logins are recognized without an in-app Connect Provider flow.
  // Deliberately omits { clearIfMissing: true } so a first-run with no
  // accounts does not wipe a pre-existing Anthropic auth entry.
  const existingStorage = await loadAccounts();
  try {
    await syncOpenCodeAuthFromStorage(existingStorage);
  } catch {
    // Best-effort; a failure here does not block plugin startup.
  }

  /** @type {AccountManager | null} */
  let accountManager = null;

  /** Track account usage toasts; show once per account change (including first use). */
  let lastToastedIndex = -1;
  /** @type {Map<string, number>} */
  const debouncedToastTimestamps = new Map();

  /** @type {Map<string, { promise: Promise<string>, source: "foreground" | "idle" }>} */
  const refreshInFlight = new Map();

  /** @type {Map<string, number>} */
  const idleRefreshLastAttempt = new Map();
  /** @type {Set<string>} */
  const idleRefreshInFlight = new Set();

  const IDLE_REFRESH_ENABLED = config.idle_refresh.enabled;
  const IDLE_REFRESH_WINDOW_MS = config.idle_refresh.window_minutes * 60 * 1000;
  const IDLE_REFRESH_MIN_INTERVAL_MS = config.idle_refresh.min_interval_minutes * 60 * 1000;

  /**
   * Pending slash-command OAuth flows keyed by session ID.
   * @type {Map<string, { mode: "login" | "reauth", verifier: string, targetIndex?: number, createdAt: number }>}
   */
  const pendingSlashOAuth = new Map();

  /**
   * Send an informational message into the current session.
   * @param {string} sessionID
   * @param {string} text
   */
  async function sendCommandMessage(sessionID, text) {
    await client.session?.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text, ignored: true }],
      },
    });
  }

  /**
   * Keep in-memory AccountManager in sync with disk mutations made via slash commands.
   */
  async function reloadAccountManagerFromDisk() {
    if (!accountManager) return;
    // Flush pending stats deltas before discarding in-memory state.
    await accountManager.saveToDisk({ preserveDiskState: true }).catch(() => {});
    accountManager = await AccountManager.load(config, null);
  }

  async function resolveFallbackOAuthAuth() {
    const stored = await loadAccounts();
    const storedAccount = getOpenCodeSyncAccount(stored);
    const storedAuth = storedAccount
      ? {
          type: "oauth",
          refresh: storedAccount.refreshToken,
          access: storedAccount.access,
          expires: storedAccount.expires,
        }
      : null;
    const openCodeAuth = await getOpenCodeAuth();

    if (storedAuth && openCodeAuth) {
      return openCodeAuth.expires > storedAuth.expires ? openCodeAuth : storedAuth;
    }
    return storedAuth || openCodeAuth;
  }

  async function resolveRuntimeOAuthAuth(getAuth) {
    const auth = await getAuth();
    if (auth?.type === "oauth") return auth;
    return resolveFallbackOAuthAuth();
  }

  /**
   * Remove expired pending OAuth flows.
   */
  function pruneExpiredPendingOAuth() {
    const now = Date.now();
    for (const [sessionID, pending] of pendingSlashOAuth.entries()) {
      if (now - pending.createdAt > PENDING_OAUTH_TTL_MS) {
        pendingSlashOAuth.delete(sessionID);
      }
    }
  }

  /**
   * Execute CLI main(argv) in-process and capture console output.
   * @param {string[]} argv
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  async function runCliCommand(argv) {
    const logs = [];
    const errors = [];

    /** @type {number} */
    let code = 1;
    try {
      code = await cliMain(argv, {
        io: {
          log: (...args) => logs.push(args.join(" ")),
          error: (...args) => errors.push(args.join(" ")),
        },
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      code,
      stdout: stripAnsi(logs.join("\n")).trim(),
      stderr: stripAnsi(errors.join("\n")).trim(),
    };
  }

  /**
   * Start a slash-command OAuth flow and store verifier in-memory.
   * @param {string} sessionID
   * @param {"login" | "reauth"} mode
   * @param {number} [targetIndex]
   */
  async function startSlashOAuth(sessionID, mode, targetIndex) {
    pruneExpiredPendingOAuth();
    const { url, verifier } = await authorize("max");
    pendingSlashOAuth.set(sessionID, {
      mode,
      verifier,
      targetIndex,
      createdAt: Date.now(),
    });

    const action = mode === "login" ? "login" : `reauth ${(targetIndex ?? 0) + 1}`;
    const followup =
      mode === "login" ? "/anthropic login complete <code#state>" : "/anthropic reauth complete <code#state>";

    await sendCommandMessage(
      sessionID,
      [
        "▣ Anthropic OAuth",
        "",
        `Started ${action} flow.`,
        "Open this URL in your browser:",
        url,
        "",
        `Then run: ${followup}`,
        "(Paste the authorization code; omit any trailing #state if shown)",
      ].join("\n"),
    );
  }

  /**
   * Complete a pending slash-command OAuth flow.
   * @param {string} sessionID
   * @param {string} code
   * @param {"login" | "reauth"} expectedMode
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async function completeSlashOAuth(sessionID, code, expectedMode) {
    const pending = pendingSlashOAuth.get(sessionID);
    if (!pending) {
      pruneExpiredPendingOAuth();
      return {
        ok: false,
        message: "No pending OAuth flow. Start with /anthropic login or /anthropic reauth <N>.",
      };
    }

    if (Date.now() - pending.createdAt > PENDING_OAUTH_TTL_MS) {
      pendingSlashOAuth.delete(sessionID);
      return {
        ok: false,
        message: "Pending OAuth flow expired. Start again with /anthropic login or /anthropic reauth <N>.",
      };
    }

    if (pending.mode !== expectedMode) {
      return {
        ok: false,
        message: `Pending ${pending.mode} OAuth flow found. Complete with /anthropic ${pending.mode} complete <code#state> or restart.`,
      };
    }

    const credentials = await exchange(code, pending.verifier);
    if (credentials.type === "failed") {
      return { ok: false, message: credentials.error || "Token exchange failed. The code may be invalid or expired." };
    }

    const loaded = await loadAccounts();
    if (!loaded && hasAccountsStorageFile()) {
      return {
        ok: false,
        message:
          "Anthropic account storage exists but could not be read. Restore or remove the file before continuing.",
      };
    }
    const stored = ensureAccountStorage(loaded);

    if (pending.mode === "login") {
      const applied = applyLoginCredentials(stored, credentials);
      if (applied.action === "updated") {
        const acc = stored.accounts[applied.index];
        const persisted = (await saveAndSync(stored)) || stored;
        const syncAccount = getOpenCodeSyncAccount(persisted);
        if (syncAccount?.refreshToken && syncAccount.access && syncAccount.expires) {
          await client.auth.set({
            path: { id: "anthropic" },
            body: {
              type: "oauth",
              refresh: syncAccount.refreshToken,
              access: syncAccount.access,
              expires: syncAccount.expires,
            },
          });
          await setOpenCodeAuth({
            refresh: syncAccount.refreshToken,
            access: syncAccount.access,
            expires: syncAccount.expires,
          });
        }
        await reloadAccountManagerFromDisk();
        pendingSlashOAuth.delete(sessionID);
        const name = acc.email || `Account ${applied.index + 1}`;
        return { ok: true, message: `Updated existing account #${applied.index + 1} (${name}).` };
      }

      if (applied.action === "capacity_reached") {
        return { ok: false, message: "Maximum of 10 accounts reached. Remove one first." };
      }
      const persisted = (await saveAndSync(stored)) || stored;
      const syncAccount = getOpenCodeSyncAccount(persisted);
      if (syncAccount?.refreshToken && syncAccount.access && syncAccount.expires) {
        await client.auth.set({
          path: { id: "anthropic" },
          body: {
            type: "oauth",
            refresh: syncAccount.refreshToken,
            access: syncAccount.access,
            expires: syncAccount.expires,
          },
        });
        await setOpenCodeAuth({
          refresh: syncAccount.refreshToken,
          access: syncAccount.access,
          expires: syncAccount.expires,
        });
      }
      await reloadAccountManagerFromDisk();
      pendingSlashOAuth.delete(sessionID);
      const label = credentials.email || `Account ${applied.index + 1}`;
      return { ok: true, message: `Added account #${applied.index + 1} (${label}).` };
    }

    // reauth flow
    const idx = pending.targetIndex ?? -1;
    if (idx < 0 || idx >= stored.accounts.length) {
      pendingSlashOAuth.delete(sessionID);
      return { ok: false, message: "Target account no longer exists. Start reauth again." };
    }

    const applied = applyReauthCredentials(stored, idx, credentials);
    if (applied.type === "missing") {
      pendingSlashOAuth.delete(sessionID);
      return { ok: false, message: "Target account no longer exists. Start reauth again." };
    }
    if (applied.type === "duplicate") {
      pendingSlashOAuth.delete(sessionID);
      return {
        ok: false,
        message: `Those credentials already belong to account #${applied.index + 1}. Reauth the correct account.`,
      };
    }
    const existing = applied.account;

    const persisted = (await saveAndSync(stored)) || stored;
    const syncAccount = getOpenCodeSyncAccount(persisted);
    if (syncAccount?.refreshToken && syncAccount.access && syncAccount.expires) {
      await client.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: syncAccount.refreshToken,
          access: syncAccount.access,
          expires: syncAccount.expires,
        },
      });
      await setOpenCodeAuth({
        refresh: syncAccount.refreshToken,
        access: syncAccount.access,
        expires: syncAccount.expires,
      });
    }
    await reloadAccountManagerFromDisk();
    pendingSlashOAuth.delete(sessionID);
    const name = existing.email || `Account ${idx + 1}`;
    return { ok: true, message: `Re-authenticated account #${idx + 1} (${name}).` };
  }

  /**
   * Handle /anthropic slash commands.
   *
   * Supported examples:
   *   /anthropic
   *   /anthropic usage
   *   /anthropic switch 2
   *   /anthropic login
   *   /anthropic login complete <code#state>
   *   /anthropic reauth 1
   *   /anthropic reauth complete <code#state>
   *
   * @param {{ command: string, arguments?: string, sessionID: string }} input
   */
  async function handleAnthropicSlashCommand(input) {
    const args = parseCommandArgs(input.arguments || "");
    const primaryToken = (args[0] || "list").toLowerCase();
    const resolvedPrimary = resolveSlashCommandName(primaryToken);
    const primary = resolvedPrimary || primaryToken;

    // Two-step login flow for slash commands
    if (primary === "login") {
      if ((args[1] || "").toLowerCase() === "complete") {
        const code = args.slice(2).join(" ").trim();
        if (!code) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic login complete <code#state>",
          );
          return;
        }
        const result = await completeSlashOAuth(input.sessionID, code, "login");
        const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
        await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
        return;
      }

      await startSlashOAuth(input.sessionID, "login");
      return;
    }

    // Two-step reauth flow for slash commands
    if (primary === "reauth") {
      if ((args[1] || "").toLowerCase() === "complete") {
        const code = args.slice(2).join(" ").trim();
        if (!code) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic reauth complete <code#state>",
          );
          return;
        }
        const result = await completeSlashOAuth(input.sessionID, code, "reauth");
        const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
        await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
        return;
      }

      const n = parseInt(args[1], 10);
      if (Number.isNaN(n) || n < 1) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic OAuth\n\nProvide an account number. Example: /anthropic reauth 1",
        );
        return;
      }
      const stored = await loadAccounts();
      if (!stored || stored.accounts.length === 0) {
        await sendCommandMessage(input.sessionID, "▣ Anthropic OAuth (error)\n\nNo accounts configured.");
        return;
      }
      const idx = n - 1;
      if (idx >= stored.accounts.length) {
        await sendCommandMessage(
          input.sessionID,
          `▣ Anthropic OAuth (error)\n\nAccount ${n} does not exist. You have ${stored.accounts.length} account(s).`,
        );
        return;
      }

      await startSlashOAuth(input.sessionID, "reauth", idx);
      return;
    }

    // Interactive CLI command is not compatible with slash flow.
    if (isInteractiveOnlyCommand(primary)) {
      await sendCommandMessage(
        input.sessionID,
        "▣ Anthropic\n\n`manage` is interactive-only. Use granular slash commands (switch/enable/disable/remove/reset) or run `opencode-anthropic-auth manage` in a terminal.",
      );
      return;
    }

    // Route remaining commands through the CLI command surface.
    const cliArgs = [...args];
    if (cliArgs.length === 0) cliArgs.push("list");
    if (resolvedPrimary) {
      cliArgs[0] = primary;
    }

    // Avoid readline prompts in slash mode.
    if (isDestructiveCommand(primary) && !cliArgs.includes("--force")) {
      cliArgs.push("--force");
    }

    const result = await runCliCommand(cliArgs);
    const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
    const body = result.stdout || result.stderr || "No output.";
    await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
    await reloadAccountManagerFromDisk();
  }

  /**
   * Show a toast in the TUI. Silently fails if TUI is not running.
   * @param {string} message
   * @param {"info" | "success" | "warning" | "error"} variant
   * @param {{debounceKey?: string}} [options]
   */
  async function toast(message, variant = "info", options = {}) {
    // Quiet mode suppresses non-error toasts
    if (config.toasts.quiet && variant !== "error") return;

    // Debounce configured toast categories to reduce chatter.
    if (variant !== "error" && options.debounceKey) {
      const minGapMs = Math.max(0, config.toasts.debounce_seconds) * 1000;
      if (minGapMs > 0) {
        const now = Date.now();
        const lastAt = debouncedToastTimestamps.get(options.debounceKey) ?? 0;
        if (now - lastAt < minGapMs) {
          return;
        }
        debouncedToastTimestamps.set(options.debounceKey, now);
      }
    }

    try {
      await client.tui?.showToast({ body: { message, variant } });
    } catch {
      // TUI may not be available
    }
  }

  /**
   * Emit debug logs when config.debug is enabled.
   * @param {...unknown} args
   */
  function debugLog(...args) {
    if (!config.debug) return;
    console.error("[opencode-anthropic-auth]", ...args);
  }

  /**
   * Parse refresh error details for retry/disable decisions.
   * @param {unknown} refreshError
   * @returns {{message: string, status: number, errorCode: string, isInvalidGrant: boolean, isTerminalStatus: boolean}}
   */
  function parseRefreshFailure(refreshError) {
    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
    const status =
      typeof refreshError === "object" && refreshError && "status" in refreshError ? Number(refreshError.status) : NaN;
    const errorCode =
      typeof refreshError === "object" && refreshError && ("errorCode" in refreshError || "code" in refreshError)
        ? String(refreshError.errorCode || refreshError.code || "")
        : "";
    const msgLower = message.toLowerCase();
    const isInvalidGrant =
      errorCode === "invalid_grant" || errorCode === "invalid_request" || msgLower.includes("invalid_grant");
    const isTerminalStatus = status === 400 || status === 401 || status === 403;
    return { message, status, errorCode, isInvalidGrant, isTerminalStatus };
  }

  /**
   * Refresh a specific account token with single-flight protection.
   * Prevents concurrent refresh races from disabling healthy accounts.
   * @param {import('./lib/accounts.mjs').ManagedAccount} account
   * @param {"foreground" | "idle"} [source]
   * @returns {Promise<string>}
   */
  async function refreshAccountTokenSingleFlight(account, source = "foreground") {
    const key = account.id;
    const existing = refreshInFlight.get(key);
    if (existing) {
      // Foreground requests should not directly inherit idle refresh failures.
      // Wait for idle maintenance to finish, then re-evaluate token state.
      if (source === "foreground" && existing.source === "idle") {
        try {
          await existing.promise;
        } catch {
          // Ignore idle failure here; foreground path handles refresh decisions.
        }

        if (account.access && account.expires && account.expires > Date.now()) {
          return account.access;
        }
      } else {
        return existing.promise;
      }
    }

    /** @type {{ promise: Promise<string>, source: "foreground" | "idle" }} */
    const entry = { source, promise: Promise.resolve("") };
    const p = (async () => {
      try {
        return await refreshAccountToken(account, client, source, {
          onTokensUpdated: async () => {
            try {
              await accountManager.saveToDisk();
            } catch {
              // Synchronous save failed (disk full, permissions, etc.).
              // Schedule a debounced retry so the rotated token eventually
              // reaches disk.  Another process may hit invalid_grant in the
              // interim, but its retry-from-disk logic can recover once this
              // save lands.
              accountManager.requestSaveToDisk();
              throw new Error("save failed, debounced retry scheduled");
            }
          },
        });
      } finally {
        if (refreshInFlight.get(key) === entry) {
          refreshInFlight.delete(key);
        }
      }
    })();

    entry.promise = p;
    refreshInFlight.set(key, entry);
    return p;
  }

  /**
   * Refresh one idle (non-active) account in the background.
   * Best-effort only: never disables accounts from background maintenance.
   * @param {import('./lib/accounts.mjs').ManagedAccount} account
   * @returns {Promise<void>}
   */
  async function refreshIdleAccount(account) {
    if (!accountManager) return;
    if (idleRefreshInFlight.has(account.id)) return;

    idleRefreshInFlight.add(account.id);
    const attemptedRefreshToken = account.refreshToken;

    try {
      try {
        await refreshAccountTokenSingleFlight(account, "idle");
        return;
      } catch (err) {
        let details = parseRefreshFailure(err);

        if (!(details.isInvalidGrant || details.isTerminalStatus)) {
          debugLog("idle refresh skipped after transient failure", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message,
          });
          return;
        }

        const diskAuth = await readDiskAccountAuth(account);
        const retryToken = diskAuth?.refreshToken;
        if (retryToken && retryToken !== attemptedRefreshToken && account.refreshToken === attemptedRefreshToken) {
          account.refreshToken = retryToken;
          if (diskAuth?.tokenUpdatedAt) {
            account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
          } else {
            markTokenStateUpdated(account);
          }
        }

        try {
          await refreshAccountTokenSingleFlight(account, "idle");
          return;
        } catch (retryErr) {
          details = parseRefreshFailure(retryErr);
          debugLog("idle refresh retry failed", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message,
          });
          return;
        }
      }
    } finally {
      idleRefreshInFlight.delete(account.id);
    }
  }

  /**
   * Opportunistically refresh one near-expiry idle account in background.
   * Runs during normal requests so inactive accounts stay healthy.
   * @param {import('./lib/accounts.mjs').ManagedAccount} activeAccount
   */
  function maybeRefreshIdleAccounts(activeAccount) {
    if (!IDLE_REFRESH_ENABLED || !accountManager) return;

    const now = Date.now();
    const excluded = new Set([activeAccount.index]);
    const candidates = accountManager
      .getEnabledAccounts(excluded)
      .filter((acc) => !acc.expires || acc.expires <= now + IDLE_REFRESH_WINDOW_MS)
      .filter((acc) => {
        const last = idleRefreshLastAttempt.get(acc.id) ?? 0;
        return now - last >= IDLE_REFRESH_MIN_INTERVAL_MS;
      })
      .sort((a, b) => (a.expires ?? 0) - (b.expires ?? 0));

    const target = candidates[0];
    if (!target) return;

    idleRefreshLastAttempt.set(target.id, now);
    void refreshIdleAccount(target);
  }

  return {
    // A1-A4: System prompt transform (unchanged)
    "experimental.chat.system.transform": (input, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID !== "anthropic") return;
      if (!Array.isArray(output.system)) return;

      // Mutate in place — reassigning output.system breaks the caller's reference.
      // Remove exact matches of the prefix.
      for (let i = output.system.length - 1; i >= 0; i--) {
        if (output.system[i] === prefix) output.system.splice(i, 1);
      }
      // Strip prefix prepended to other entries (BUILTIN double-insert pattern:
      // system[1] = prefix + "\n\n" + rest). Only matches the known pattern.
      for (let i = 0; i < output.system.length; i++) {
        if (typeof output.system[i] === "string" && output.system[i].startsWith(prefix + "\n")) {
          output.system[i] = output.system[i].slice(prefix.length).replace(/^\n+/, "");
        }
      }
      // Remove any existing billing header blocks (BUILTIN coexistence dedup).
      for (let i = output.system.length - 1; i >= 0; i--) {
        if (typeof output.system[i] === "string" && output.system[i].startsWith("x-anthropic-billing-header:")) {
          output.system.splice(i, 1);
        }
      }
      output.system.unshift(prefix);
      if (config.headers.billing_header) {
        output.system.unshift(getBillingHeaderBlock(config.headers.emulation_profile));
      }
    },
    config: async (input) => {
      input.command ??= {};
      input.command["anthropic"] = {
        template: "/anthropic",
        description: "Manage Anthropic multi-account auth (status, usage, switch, login, reauth, logout)",
      };
    },
    "command.execute.before": async (input) => {
      if (input.command !== "anthropic") return;

      try {
        await handleAnthropicSlashCommand(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sendCommandMessage(input.sessionID, `▣ Anthropic (error)\n\n${message}`);
      }

      throw new Error(ANTHROPIC_COMMAND_HANDLED);
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const resolvedAuth = await resolveRuntimeOAuthAuth(getAuth);

        if (resolvedAuth?.type === "oauth") {
          // B1-B2: Zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }

          // Initialize AccountManager from disk + OpenCode auth fallback
          accountManager = await AccountManager.load(config, {
            refresh: resolvedAuth.refresh,
            access: resolvedAuth.access,
            expires: resolvedAuth.expires,
          });

          // If we bootstrapped from auth.json and have no stored accounts file,
          // save immediately to create it (debounced save may not fire in time)
          if (accountManager.getAccountCount() > 0) {
            await accountManager.saveToDisk();
          }

          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              // Re-read auth for non-oauth fallback
              const currentAuth = await resolveRuntimeOAuthAuth(getAuth);
              if (currentAuth?.type !== "oauth") return fetch(input, init);

              // Transform body and URL once (shared across retries)
              const requestInit = init ?? {};
              const body = transformRequestBody(requestInit.body);
              const modelName = extractModelName(body);
              const { requestInput, requestUrl } = transformRequestUrl(input);
              const requestMethod = String(
                requestInit.method || (requestInput instanceof Request ? requestInput.method : "POST"),
              ).toUpperCase();
              const showUsageToast = requestUrl?.pathname === "/v1/messages" && requestMethod === "POST";

              let lastError = null;
              const transientRefreshSkips = new Set();

              // Sync with CLI changes at request start.
              if (accountManager) {
                await accountManager.syncActiveIndexFromDisk();
              }

              // Try each account at most once. If the error is account-specific,
              // switch to the next account. If it's service-wide, return immediately.
              const maxAttempts = accountManager.getAccountCount();

              if (maxAttempts === 0) {
                throw new Error(
                  "No enabled Anthropic accounts available. Enable one with 'opencode-anthropic-auth enable <N>'.",
                );
              }

              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // Select account
                const account = accountManager.getCurrentAccount(transientRefreshSkips);

                // Toast account usage on first use and whenever the account changes
                if (showUsageToast && account && accountManager) {
                  const currentIndex = accountManager.getCurrentIndex();
                  if (currentIndex !== lastToastedIndex) {
                    const name = account.email || `Account ${currentIndex + 1}`;
                    const total = accountManager.getAccountCount();
                    const msg = total > 1 ? `Claude: ${name} (${currentIndex + 1}/${total})` : `Claude: ${name}`;
                    await toast(msg, "info", { debounceKey: "account-usage" });
                    lastToastedIndex = currentIndex;
                  }
                }

                if (!account) {
                  const enabledCount = accountManager.getAccountCount();
                  if (enabledCount === 0) {
                    throw new Error(
                      "No enabled Anthropic accounts available. Enable one with 'opencode-anthropic-auth enable <N>'.",
                    );
                  }
                  // Enabled accounts exist, but none are currently selectable.
                  const reason = buildNoAvailableAccountReason(accountManager, transientRefreshSkips, lastError);
                  await toast(`All Anthropic accounts unavailable: ${reason}`, "error");
                  throw new Error(`No available Anthropic account for request: ${reason}`);
                }

                // Determine access token
                let accessToken;
                // Per-account token refresh
                if (!account.access || !account.expires || account.expires < Date.now()) {
                  const attemptedRefreshToken = account.refreshToken;
                  try {
                    accessToken = await refreshAccountTokenSingleFlight(account);
                    // Tokens are now saved under the refresh lock (inside
                    // refreshAccountToken) so no debounced save needed here.
                  } catch (err) {
                    // Token refresh failed — check if another instance rotated the
                    // refresh token and persisted it between attempts.
                    let finalError = err;
                    let details = parseRefreshFailure(err);

                    // Belt-and-suspenders retry: on terminal/invalid_grant failures,
                    // always re-read disk token and retry once before disabling.
                    if (details.isInvalidGrant || details.isTerminalStatus) {
                      const diskAuth = await readDiskAccountAuth(account);
                      const retryToken = diskAuth?.refreshToken;
                      if (
                        retryToken &&
                        retryToken !== attemptedRefreshToken &&
                        account.refreshToken === attemptedRefreshToken
                      ) {
                        debugLog("refresh token on disk differs from in-memory, retrying with disk token", {
                          accountIndex: account.index,
                        });
                        account.refreshToken = retryToken;
                        if (diskAuth?.tokenUpdatedAt) {
                          account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
                        } else {
                          markTokenStateUpdated(account);
                        }
                      } else if (retryToken && retryToken !== attemptedRefreshToken) {
                        debugLog("skipping disk token adoption because in-memory token already changed", {
                          accountIndex: account.index,
                        });
                      }

                      try {
                        accessToken = await refreshAccountTokenSingleFlight(account);
                      } catch (retryErr) {
                        finalError = retryErr;
                        details = parseRefreshFailure(retryErr);
                        debugLog("retry refresh failed", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message,
                        });
                      }
                    }

                    if (!accessToken) {
                      accountManager.markFailure(account);

                      if (details.isInvalidGrant || details.isTerminalStatus) {
                        const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                        debugLog("disabling account after terminal refresh failure", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message,
                        });
                        account.enabled = false;
                        accountManager.requestSaveToDisk();
                        const statusLabel = Number.isFinite(details.status)
                          ? `HTTP ${details.status}`
                          : "unknown status";
                        await toast(
                          `Disabled ${name} (token refresh failed: ${details.errorCode || statusLabel})`,
                          "error",
                        );
                      } else {
                        // Skip this account for the remainder of this request.
                        transientRefreshSkips.add(account.index);
                      }
                      lastError = finalError;
                      continue; // Try next account
                    }
                  }
                } else {
                  accessToken = account.access;
                }

                // Keep non-active accounts warm without blocking the request.
                maybeRefreshIdleAccounts(account);

                // Build headers with the selected account's token
                const requestHeaders = buildRequestHeaders(input, requestInit, accessToken, config.headers, modelName);

                // Execute the request
                let response;
                try {
                  response = await fetch(requestInput, {
                    ...requestInit,
                    body,
                    headers: requestHeaders,
                  });
                } catch (err) {
                  const fetchError = err instanceof Error ? err : new Error(String(err));

                  if (accountManager && account) {
                    accountManager.markFailure(account);
                    transientRefreshSkips.add(account.index);
                    lastError = fetchError;
                    debugLog("request fetch threw, trying next account", {
                      accountIndex: account.index,
                      message: fetchError.message,
                    });
                    continue;
                  }

                  throw fetchError;
                }

                // On error, check if it's account-specific or service-wide
                if (!response.ok && accountManager && account) {
                  let errorBody = null;
                  try {
                    errorBody = await response.clone().text();
                  } catch {
                    // Ignore read errors
                  }

                  if (isAccountSpecificError(response.status, errorBody)) {
                    // Account-specific: mark this account, try the next one
                    const reason = parseRateLimitReason(response.status, errorBody);
                    const retryAfterMs = parseRetryAfterHeader(response);
                    const authOrPermissionIssue = reason === "AUTH_FAILED";

                    // Auth failures should force token refresh on next use.
                    if (reason === "AUTH_FAILED") {
                      account.access = undefined;
                      account.expires = undefined;
                      markTokenStateUpdated(account);
                    }

                    debugLog("account-specific error, switching account", {
                      accountIndex: account.index,
                      status: response.status,
                      reason,
                    });

                    accountManager.markRateLimited(account, reason, authOrPermissionIssue ? null : retryAfterMs);

                    const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                    const total = accountManager.getAccountCount();
                    if (total > 1) {
                      const switchReason = formatSwitchReason(response.status, reason);
                      await toast(`${name} ${switchReason}, switching account`, "warning", {
                        debounceKey: "account-switch",
                      });
                    }

                    continue; // Try next account immediately
                  }

                  // Service-wide error (529, 503, 500, etc.) — return to caller,
                  // switching accounts won't help
                  debugLog("service-wide response error, returning directly", {
                    status: response.status,
                  });
                  return transformResponse(response);
                }

                // Success
                if (account && accountManager) {
                  if (response.ok) {
                    accountManager.markSuccess(account);
                  }
                }

                // Wire usage tracking and mid-stream error detection for SSE responses only.
                const shouldInspectStream = response.ok && account && accountManager && isEventStreamResponse(response);

                const usageCallback = shouldInspectStream
                  ? (/** @type {UsageStats} */ usage) => {
                      accountManager.recordUsage(account.index, usage);
                    }
                  : null;

                const accountErrorCallback = shouldInspectStream
                  ? (details) => {
                      // Mid-stream account error: mark for NEXT request
                      if (details.invalidateToken) {
                        account.access = undefined;
                        account.expires = undefined;
                        markTokenStateUpdated(account);
                      }
                      accountManager.markRateLimited(account, details.reason, null);
                    }
                  : null;

                return transformResponse(response, usageCallback, accountErrorCallback);
              }

              // All accounts tried
              if (lastError) throw lastError;
              throw new Error("All accounts exhausted — no account could serve this request");
            },
          };
        }

        return {};
      },
      methods: [
        {
          // H1: Claude Pro/Max OAuth — now with multi-account support
          label: "Claude Pro/Max (multi-account)",
          type: "oauth",
          authorize: async () => {
            // Check for existing accounts
            const stored = await loadAccounts();
            if (stored && stored.accounts.length > 0) {
              if (!accountManager) {
                accountManager = await AccountManager.load(config, null);
              }
              const action = await promptAccountMenu(accountManager);

              if (action === "cancel") {
                return {
                  url: "about:blank",
                  instructions: "Cancelled.",
                  method: "code",
                  callback: async () => ({ type: "failed" }),
                };
              }

              if (action === "manage") {
                await promptManageAccounts(accountManager);
                accountManager = await AccountManager.load(config, null);
                return {
                  url: "about:blank",
                  instructions: "Account management complete. Re-run auth to add accounts.",
                  method: "code",
                  callback: async () => ({ type: "failed" }),
                };
              }

              if (action === "fresh") {
                await clearAccounts();
                await clearOpenCodeAuth();
                accountManager.clearAll();
              }

              // action === "add" or "fresh" — fall through to OAuth flow
            }

            const { url, verifier } = await authorize("max");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;

                // Initialize AccountManager if not yet loaded (first login —
                // loader() hasn't run yet because auth hasn't completed)
                if (!accountManager) {
                  accountManager = await AccountManager.load(config, null);
                }

                // Add to account pool and persist immediately
                const loaded = await loadAccounts();
                if (!loaded && hasAccountsStorageFile()) {
                  return {
                    type: "failed",
                    error:
                      "Anthropic account storage exists but could not be read. Restore or remove the file before continuing.",
                  };
                }
                const stored = ensureAccountStorage(loaded);
                const countBefore = stored.accounts.length;
                const applied = applyLoginCredentials(stored, credentials);
                if (applied.action === "capacity_reached") {
                  return { type: "failed", error: "Maximum of 10 accounts reached. Remove one first." };
                }
                try {
                  await saveAndSync(stored);
                } catch {
                  // Plugin-managed storage is now the source of truth; auth.json sync is best-effort.
                }
                accountManager = await AccountManager.load(config, null);

                // Toast the result
                const total = stored.accounts.length;
                const name = credentials.email || "account";
                if (applied.action === "added" && countBefore > 0) {
                  await toast(`Added ${name} — ${total} accounts`, "success");
                } else if (applied.action === "updated") {
                  await toast(`Updated ${name}`, "success");
                } else {
                  await toast(`Authenticated (${name})`, "success");
                }

                return credentials;
              },
            };
          },
        },
        {
          // H2: Create an API Key (unchanged)
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                let result;
                try {
                  const resp = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  });
                  if (!resp.ok) {
                    const text = await resp.text().catch(() => "");
                    return { type: "failed", error: `API key creation failed (HTTP ${resp.status}): ${text}` };
                  }
                  result = await resp.json();
                } catch (err) {
                  return { type: "failed", error: `API key creation failed: ${err.message}` };
                }
                if (!result?.raw_key) {
                  return { type: "failed", error: "API key creation failed: no key in response" };
                }
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          // H3: Manual API Key (unchanged)
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}
