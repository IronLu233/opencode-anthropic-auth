import type { Plugin } from "@opencode-ai/plugin";
import { randomBytes, createHash } from "node:crypto";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_CODE_VERSION = "2.1.76";
const BILLING_SALT = "59cf53e54c78";

function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function createAuthorizationRequest() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier };
}

function parseAuthCode(raw: string): string {
  const hashIdx = raw.indexOf("#");
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
}

async function exchangeCodeForTokens(rawCode: string, verifier: string) {
  const code = parseAuthCode(rawCode.trim());
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "anthropic",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

function sampleCodeUnits(text: string, indices: number[]): string {
  return indices.map((i) => (i < text.length ? text.charCodeAt(i).toString(16) : "30")).join("");
}

function billingHeader(firstUserMsg: string): string {
  const sampled = sampleCodeUnits(firstUserMsg, [4, 7, 20]);
  const hash = createHash("sha256").update(`${BILLING_SALT}${sampled}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${hash}; cc_entrypoint=cli; cch=00000;`;
}

function firstUserText(input: any): string {
  try {
    const messages = input?.messages ?? input?.request?.messages ?? [];
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) return block.text;
        }
      }
    }
  } catch {}
  return "";
}

const plugin: Plugin = async () => {
  return {
    auth: {
      provider: "anthropic",
      methods: [
        {
          type: "oauth" as const,
          label: "Claude Pro/Max",
          authorize() {
            const { url, verifier } = createAuthorizationRequest();
            return Promise.resolve({
              url,
              instructions:
                "Open the link above to authenticate with your Claude account. " +
                "After authorizing, you'll receive a code — paste it below.",
              method: "code" as const,
              async callback(code: string) {
                try {
                  const tokens = await exchangeCodeForTokens(code, verifier);
                  return {
                    type: "success" as const,
                    access: tokens.access,
                    refresh: tokens.refresh,
                    expires: tokens.expires,
                  };
                } catch (err) {
                  console.error("anthropic-oauth: token exchange failed:", err instanceof Error ? err.message : err);
                  return { type: "failed" as const };
                }
              },
            });
          },
        },
      ],
    },

    "chat.headers": async (input, output) => {
      if (input.provider?.info?.id !== "anthropic") return;
      output.headers["user-agent"] = `claude-code/${CLAUDE_CODE_VERSION}`;
      output.headers["anthropic-beta"] = "oauth-2025-04-20";
      output.headers["x-app"] = "cli";
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      if (input?.provider?.info?.id !== "anthropic") return;
      const userMsg = firstUserText(input);
      output.system.unshift(billingHeader(userMsg));
    },
  };
};

export default plugin;
