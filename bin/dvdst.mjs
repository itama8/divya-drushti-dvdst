#!/usr/bin/env node
// Runs the TypeScript dispatcher with the tsx that ships with this package,
// so `dvdst` works from any working directory.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/dvdst.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
