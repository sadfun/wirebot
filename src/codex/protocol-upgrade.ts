import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { externalProcessEnvironment } from "../shared/environment.js";
import { errorMessage } from "../shared/errors.js";
import { atomicWriteFile, atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";
import { CodexToolchainManager, readPinnedCodexVersion } from "./toolchain.js";

const protocolMethodsSchema = z.object({
  clientRequests: z.array(z.string()),
  clientNotifications: z.array(z.string()),
  serverRequests: z.array(z.string()),
  serverNotifications: z.array(z.string()),
});

const protocolManifestSchema = z.object({
  codexVersion: z.string(),
  methods: protocolMethodsSchema,
});

export type ProtocolManifest = z.infer<typeof protocolManifestSchema>;
export type ProtocolMethods = ProtocolManifest["methods"];

export interface ProtocolCheckOptions {
  readonly projectRoot: string;
  readonly requestedVersion: string;
  readonly apply: boolean;
  readonly logger: Logger;
}

export interface ProtocolMethodChanges {
  readonly added: ProtocolMethods;
  readonly removed: ProtocolMethods;
}

export interface ProtocolCheckResult {
  readonly previousVersion: string;
  readonly candidateVersion: string;
  readonly compatible: boolean;
  readonly applied: boolean;
  readonly generatedTypeFiles: number;
  readonly methodChanges: ProtocolMethodChanges;
  /** Removed methods that handwritten src/ still references; anything else removed is informational. */
  readonly breakingRemovals: readonly string[];
  readonly manifest: ProtocolManifest;
}

const methodFiles = {
  clientRequests: "ClientRequest.ts",
  clientNotifications: "ClientNotification.ts",
  serverRequests: "ServerRequest.ts",
  serverNotifications: "ServerNotification.ts",
} as const satisfies Readonly<Record<keyof ProtocolMethods, string>>;

const methodGroups = Object.keys(methodFiles) as readonly (keyof ProtocolMethods)[];

export async function checkCodexProtocol(
  options: ProtocolCheckOptions,
): Promise<ProtocolCheckResult> {
  const projectRoot = resolve(options.projectRoot);
  const previousVersion = await readPinnedCodexVersion(projectRoot);
  const toolchainsDirectory = join(projectRoot, ".wirebot", "toolchains");
  const manager = new CodexToolchainManager(toolchainsDirectory, options.logger);
  const candidateVersion =
    options.requestedVersion === "latest"
      ? await manager.latestVersion()
      : options.requestedVersion;
  const codexBinary = await manager.ensureVersion(candidateVersion);

  const stageRoot = join(
    projectRoot,
    ".wirebot",
    "upgrade",
    `${candidateVersion}-${crypto.randomUUID()}`,
  );
  const bindingsDirectory = join(stageRoot, "bindings");
  const experimentalBindingsDirectory = join(stageRoot, "experimental-bindings");

  await ensureDirectory(stageRoot);
  try {
    options.logger.info("Generating candidate Codex protocol", {
      candidateVersion,
    });
    await generateProtocol(
      codexBinary,
      projectRoot,
      join(stageRoot, "codex-home"),
      bindingsDirectory,
    );
    await validateExperimentalProtocol(
      codexBinary,
      projectRoot,
      join(stageRoot, "codex-home"),
      experimentalBindingsDirectory,
    );

    const generatedTypeFiles = (await listFiles(bindingsDirectory, ".ts")).length;
    if (generatedTypeFiles === 0) {
      throw new Error(`Codex generated no TypeScript files in ${bindingsDirectory}`);
    }
    const manifest = await createProtocolManifest(candidateVersion, bindingsDirectory);
    const baseline = await readBaselineManifest(projectRoot, previousVersion);
    const methodChanges = compareMethods(baseline.methods, manifest.methods);
    const breakingRemovals = await findReferencedMethods(
      join(projectRoot, "src"),
      methodGroups.flatMap((group) => [...methodChanges.removed[group]]),
    );
    const compatible = breakingRemovals.length === 0;

    let applied = false;
    if (options.apply && compatible) {
      await applyProtocol(projectRoot, bindingsDirectory, candidateVersion, manifest);
      applied = true;
    }

    return {
      previousVersion,
      candidateVersion,
      compatible,
      applied,
      generatedTypeFiles,
      methodChanges,
      breakingRemovals,
      manifest,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

async function createProtocolManifest(
  codexVersion: string,
  bindingsDirectory: string,
): Promise<ProtocolManifest> {
  const methods = await readMethods(bindingsDirectory);
  for (const group of methodGroups) {
    if (methods[group].length === 0) {
      throw new Error(`${methodFiles[group]} contains no JSON-RPC methods`);
    }
  }
  return { codexVersion, methods };
}

async function generateProtocol(
  codexBinary: string,
  projectRoot: string,
  codexHome: string,
  bindingsDirectory: string,
): Promise<void> {
  await ensureDirectory(codexHome);
  await ensureDirectory(bindingsDirectory);
  await runCommand(codexBinary, ["app-server", "generate-ts", "--out", bindingsDirectory], {
    cwd: projectRoot,
    env: externalProcessEnvironment({ CODEX_HOME: codexHome }),
  });
}

/** Asserts the experimental fields that rpc.ts hand-augments; the typecheck covers the rest. */
async function validateExperimentalProtocol(
  codexBinary: string,
  projectRoot: string,
  codexHome: string,
  bindingsDirectory: string,
): Promise<void> {
  await ensureDirectory(bindingsDirectory);
  await runCommand(
    codexBinary,
    ["app-server", "generate-ts", "--experimental", "--out", bindingsDirectory],
    {
      cwd: projectRoot,
      env: externalProcessEnvironment({ CODEX_HOME: codexHome }),
    },
  );
  const turnStart = await readFile(join(bindingsDirectory, "v2", "TurnStartParams.ts"), "utf8");
  if (!turnStart.includes("additionalContext")) {
    throw new Error("Codex no longer exposes turn/start.additionalContext");
  }
  const threadStart = await readFile(join(bindingsDirectory, "v2", "ThreadStartParams.ts"), "utf8");
  if (!threadStart.includes("dynamicTools")) {
    throw new Error("Codex no longer exposes thread/start.dynamicTools");
  }
}

async function readBaselineManifest(
  projectRoot: string,
  pinnedVersion: string,
): Promise<{ readonly methods: ProtocolMethods }> {
  const path = join(projectRoot, "src", "generated", "codex", "protocol-manifest.json");
  try {
    const manifest = protocolManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (manifest.codexVersion !== pinnedVersion) {
      throw new Error(
        `Protocol manifest is for Codex ${manifest.codexVersion}, but codex.version pins ${pinnedVersion}`,
      );
    }
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      methods: await readMethods(join(projectRoot, "src", "generated", "codex")),
    };
  }
}

async function readMethods(bindingsDirectory: string): Promise<ProtocolMethods> {
  const entries = await Promise.all(
    methodGroups.map(async (group) => {
      const source = await readFile(join(bindingsDirectory, methodFiles[group]), "utf8");
      return [group, extractMethods(source)] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as ProtocolMethods;
}

function extractMethods(source: string): readonly string[] {
  const methods = new Set<string>();
  for (const match of source.matchAll(/"method"\s*:\s*"([^"]+)"/g)) {
    const method = match[1];
    if (method !== undefined) methods.add(method);
  }
  return [...methods].sort();
}

function compareMethods(
  baseline: ProtocolMethods,
  candidate: ProtocolMethods,
): ProtocolMethodChanges {
  const addedEntries = methodGroups.map(
    (group) => [group, difference(candidate[group], baseline[group])] as const,
  );
  const removedEntries = methodGroups.map(
    (group) => [group, difference(baseline[group], candidate[group])] as const,
  );
  return {
    added: Object.fromEntries(addedEntries) as unknown as ProtocolMethods,
    removed: Object.fromEntries(removedEntries) as unknown as ProtocolMethods,
  };
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

/** Which of the given method names appear as string literals in handwritten src/ (src/generated excluded). */
async function findReferencedMethods(
  sourceRoot: string,
  methods: readonly string[],
): Promise<readonly string[]> {
  if (methods.length === 0) return [];
  const referenced = new Set<string>();
  const files = await listHandwrittenSources(sourceRoot);
  for (const file of files) {
    const content = await readFile(join(sourceRoot, file), "utf8");
    for (const method of methods) {
      if (content.includes(`"${method}"`)) referenced.add(method);
    }
  }
  return methods.filter((method) => referenced.has(method));
}

async function listHandwrittenSources(sourceRoot: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(join(sourceRoot, directory), { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (normalizePath(child) === "generated") return;
          await visit(child);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          files.push(child);
        }
      }),
    );
  };
  await visit("");
  return files;
}

/**
 * Installs the bindings in place and typechecks the repo against them. This is
 * a maintainer command running in a source checkout, so git is the rollback.
 */
async function applyProtocol(
  projectRoot: string,
  bindingsDirectory: string,
  candidateVersion: string,
  manifest: ProtocolManifest,
): Promise<void> {
  const target = join(projectRoot, "src", "generated", "codex");
  await ensureDirectory(join(projectRoot, "src", "generated"));
  await rm(target, { recursive: true, force: true });
  await cp(bindingsDirectory, target, { recursive: true });
  await atomicWriteJson(join(target, "protocol-manifest.json"), manifest);
  await atomicWriteFile(join(projectRoot, "codex.version"), `${candidateVersion}\n`);
  try {
    await runCommand(
      join(projectRoot, "node_modules", ".bin", "tsc"),
      ["-p", join(projectRoot, "tsconfig.json")],
      { cwd: projectRoot, env: externalProcessEnvironment() },
    );
  } catch (error) {
    throw new Error(
      `Typecheck failed against the Codex ${candidateVersion} bindings: ${errorMessage(error)}\n` +
        "Restore the previous protocol with: git checkout -- src/generated/codex codex.version",
    );
  }
}

async function listFiles(root: string, extension: string): Promise<readonly string[]> {
  const files: string[] = [];
  await walk(root, "", extension, files);
  files.sort();
  return files;
}

async function walk(
  root: string,
  directory: string,
  extension: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(root, child, extension, files);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(normalizePath(child));
    }),
  );
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function formatProtocolCheck(result: ProtocolCheckResult): string {
  const lines = [
    `Codex protocol ${result.previousVersion} -> ${result.candidateVersion}`,
    `Generated ${result.generatedTypeFiles} TypeScript files.`,
  ];
  let removals = false;
  for (const group of methodGroups) {
    const added = result.methodChanges.added[group];
    const removed = result.methodChanges.removed[group];
    if (added.length > 0) lines.push(`Added ${group}: ${added.join(", ")}`);
    if (removed.length > 0) {
      removals = true;
      lines.push(`Removed ${group}: ${removed.join(", ")}`);
    }
  }
  if (result.breakingRemovals.length > 0) {
    lines.push(
      `Removed methods still referenced in handwritten src/: ${result.breakingRemovals.join(", ")}`,
    );
  } else if (removals) {
    lines.push("Removed methods are not referenced in handwritten src/ (informational).");
  }
  lines.push(
    result.compatible
      ? "Result: COMPATIBLE with this bridge."
      : "Result: BREAKING; update the bridge before applying this protocol.",
  );
  if (result.applied) lines.push(`Applied the Codex ${result.candidateVersion} protocol.`);
  return lines.join("\n");
}
