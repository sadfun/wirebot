import { bridgeOnlyEnvironmentKeys } from "../config/env.js";

/** Build an environment for Codex/npm subprocesses without bridge credentials. */
export function externalProcessEnvironment(
  overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of bridgeOnlyEnvironmentKeys) delete environment[key];
  return environment;
}
