import { createHash } from "node:crypto";
import { cp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { externalProcessEnvironment } from "../shared/environment.js";
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

const generatedFilesSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const protocolManifestSchema = z.object({
  schemaVersion: z.literal(2),
  codexVersion: z.string(),
  generatedAt: z.string(),
  bindings: generatedFilesSchema,
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

    const manifest = await createProtocolManifest(candidateVersion, bindingsDirectory);
    const baseline = await readBaselineManifest(projectRoot, previousVersion);
    const methodChanges = compareMethods(baseline.methods, manifest.methods);
    const compatible = !hasRemovedMethods(methodChanges.removed);

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
      generatedTypeFiles: manifest.bindings.fileCount,
      methodChanges,
      manifest,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export async function createProtocolManifest(
  codexVersion: string,
  bindingsDirectory: string,
): Promise<ProtocolManifest> {
  const bindings = await fingerprintFiles(bindingsDirectory, ".ts");
  if (bindings.fileCount === 0) {
    throw new Error(`Codex generated no TypeScript files in ${bindingsDirectory}`);
  }

  const methods = await readMethods(bindingsDirectory);
  for (const group of methodGroups) {
    if (methods[group].length === 0) {
      throw new Error(`${methodFiles[group]} contains no JSON-RPC methods`);
    }
  }

  return {
    schemaVersion: 2,
    codexVersion,
    generatedAt: new Date().toISOString(),
    bindings,
    methods,
  };
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

async function fingerprintFiles(
  directory: string,
  extension: string,
): Promise<ProtocolManifest["bindings"]> {
  const files = await listFiles(directory, extension);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(directory, file)));
    hash.update("\0");
  }
  return { fileCount: files.length, sha256: hash.digest("hex") };
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

function hasRemovedMethods(methods: ProtocolMethods): boolean {
  return methodGroups.some((group) => methods[group].length > 0);
}

/** Installs the bindings, typechecks the repo against them, and rolls back on any failure. */
async function applyProtocol(
  projectRoot: string,
  bindingsDirectory: string,
  candidateVersion: string,
  manifest: ProtocolManifest,
): Promise<void> {
  const generatedRoot = join(projectRoot, "src", "generated");
  const target = join(generatedRoot, "codex");
  const transactionId = crypto.randomUUID();
  const incoming = join(generatedRoot, `.codex.incoming.${transactionId}`);
  const backup = join(generatedRoot, `.codex.backup.${transactionId}`);
  const versionPath = join(projectRoot, "codex.version");
  const manifestPath = join(incoming, "protocol-manifest.json");
  const oldVersion = await readOptionalFile(versionPath);
  let movedCurrent = false;
  let installedIncoming = false;

  await ensureDirectory(generatedRoot);
  await cp(bindingsDirectory, incoming, { recursive: true });
  await atomicWriteJson(manifestPath, manifest);
  try {
    if (await pathExists(target)) {
      await rename(target, backup);
      movedCurrent = true;
    }
    await rename(incoming, target);
    installedIncoming = true;
    await atomicWriteFile(versionPath, `${candidateVersion}\n`);
    await runCommand(
      join(projectRoot, "node_modules", ".bin", "tsc"),
      ["-p", join(projectRoot, "tsconfig.test.json")],
      { cwd: projectRoot, env: externalProcessEnvironment() },
    );
    if (movedCurrent) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (installedIncoming) await rm(target, { recursive: true, force: true });
    if (movedCurrent) await rename(backup, target);
    await restoreOptionalFile(versionPath, oldVersion);
    throw error;
  } finally {
    await rm(incoming, { recursive: true, force: true });
  }
}

async function restoreOptionalFile(path: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) await rm(path, { force: true });
  else await atomicWriteFile(path, contents);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
  for (const group of methodGroups) {
    const added = result.methodChanges.added[group];
    const removed = result.methodChanges.removed[group];
    if (added.length > 0) lines.push(`Added ${group}: ${added.join(", ")}`);
    if (removed.length > 0) lines.push(`Removed ${group}: ${removed.join(", ")}`);
  }
  lines.push(
    result.compatible
      ? "Result: COMPATIBLE with this bridge."
      : "Result: BREAKING; update the bridge before applying this protocol.",
  );
  if (result.applied) lines.push(`Applied Codex ${result.candidateVersion} protocol atomically.`);
  return lines.join("\n");
}
