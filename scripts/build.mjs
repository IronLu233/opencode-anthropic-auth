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
});

console.log("Built dist/opencode-anthropic-auth.js");
