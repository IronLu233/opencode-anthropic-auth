#!/usr/bin/env node

import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["node:*"],
};

await build({
  ...shared,
  entryPoints: ["index.mjs"],
  outfile: "dist/opencode-anthropic-auth.js",
  plugins: [
    {
      name: "inline-txt-files",
      setup(build) {
        build.onLoad({ filter: /anthropic-system-prompt\.mjs$/ }, async (args) => {
          const { readFileSync } = await import("node:fs");
          let code = readFileSync(args.path, "utf8");
          const txtPath = args.path.replace("anthropic-system-prompt.mjs", "claude-token-system-prompt.txt");
          const txtContent = readFileSync(txtPath, "utf8");
          code = code.replace(
            /export const ANTHROPIC_REPLACEMENT_PROMPT\s*=\s*readFileSync\([^;]+\);/s,
            `export const ANTHROPIC_REPLACEMENT_PROMPT = ${JSON.stringify(txtContent)};`,
          );
          return { contents: code, loader: "js" };
        });
      },
    },
  ],
});

console.log("Built dist/opencode-anthropic-auth.js");
