import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const packageSchema = z.object({ version: z.string().min(1) });

export async function readWirebotVersion(projectRoot: string): Promise<string> {
  const contents = await readFile(join(projectRoot, "package.json"), "utf8");
  return packageSchema.parse(JSON.parse(contents)).version;
}
