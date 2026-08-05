import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Whether `candidate` is `root` itself or a path inside it (no `..` escape). */
export function isPathWithin(root: string, candidate: string): boolean {
  const rootRelative = relative(root, candidate);
  return (
    rootRelative === "" ||
    (rootRelative !== ".." && !rootRelative.startsWith(`..${sep}`) && !isAbsolute(rootRelative))
  );
}

/** The file's UTF-8 contents, or undefined when it does not exist. */
export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function atomicWriteFile(
  path: string,
  contents: string,
  mode: number = 0o600,
): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function projectRootFrom(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}
