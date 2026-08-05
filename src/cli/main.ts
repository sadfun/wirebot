#!/usr/bin/env bun

import { checkCodexProtocol, formatProtocolCheck } from "../codex/protocol-upgrade.js";
import { errorMessage } from "../shared/errors.js";
import { projectRootFrom } from "../shared/fs.js";
import { Logger } from "../shared/logger.js";
import { wirebotVersion } from "../shared/version.js";

interface CodexCheckArguments {
  readonly version: string;
  readonly apply: boolean;
}

const usage = `Usage:
  wirebot start
  wirebot version
  wirebot codex check [--version latest|VERSION] [--apply]

Codex protocol checks are maintainer commands for updating the separately
pinned Codex CLI.`;

async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(usage);
    return args.length === 0 ? 1 : 0;
  }

  switch (args[0]) {
    case "start": {
      if (args.length !== 1) throw new Error(usage);
      const { runWirebot } = await import("../index.js");
      await runWirebot();
      return 0;
    }
    case "version": {
      if (args.length !== 1) throw new Error(usage);
      console.log(wirebotVersion);
      return 0;
    }
    case "codex": {
      // Compiled release binaries do not carry the repository checkout.
      if (typeof WIREBOT_COMPILED !== "undefined") {
        throw new Error(
          "wirebot codex check is a maintainer command; run it from a source checkout.",
        );
      }
      return await checkCodex(parseCodexArguments(args));
    }
    default:
      throw new Error(usage);
  }
}

async function checkCodex(args: CodexCheckArguments): Promise<number> {
  const result = await checkCodexProtocol({
    projectRoot: projectRootFrom(import.meta.url),
    requestedVersion: args.version,
    apply: args.apply,
    logger: new Logger("info", { component: "protocol-check" }),
  });
  console.log(formatProtocolCheck(result));
  if (args.apply && result.compatible && !result.applied) return 1;
  return result.compatible ? 0 : 2;
}

function parseCodexArguments(args: readonly string[]): CodexCheckArguments {
  if (args[0] !== "codex" || args[1] !== "check") throw new Error(usage);
  let version = "latest";
  let apply = false;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--version") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--version requires latest or an exact Codex version");
      }
      version = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage}`);
  }
  return { version, apply };
}

// No top-level await: bytecode compilation requires a CommonJS-representable entry.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  },
);
