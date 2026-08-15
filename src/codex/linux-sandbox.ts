import { errorMessage } from "../shared/errors.js";
import { runCommand } from "../shared/process.js";

const APPARMOR_USERNS_PROFILES = ["rootlesskit", "podman", "vscode"] as const;
const BWRAP_USERNS_FAILURES = [
  "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
  "bwrap: setting up uid map: Permission denied",
  "bwrap: No permissions to create a new namespace",
] as const;

export interface CodexLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly appArmorProfile?: string;
}

interface CodexLaunchResolverOptions {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Modern Codex releases prefer a vendored bubblewrap helper on Linux. Ubuntu's
 * AppArmor userns restriction can strip the helper's namespace capabilities,
 * which makes every sandboxed command fail before it starts. When that exact
 * failure is observed, retry the probe under an already-loaded, root-managed
 * unconfined+userns profile and use the first profile that succeeds.
 */
export async function resolveCodexLaunch(
  options: CodexLaunchResolverOptions,
): Promise<CodexLaunch> {
  const direct = { executable: options.binaryPath, args: options.args };
  if (process.platform !== "linux") return direct;

  const probeArgs = ["sandbox", "/bin/true"] as const;
  try {
    await runCommand(options.binaryPath, probeArgs, { cwd: options.cwd, env: options.env });
    return direct;
  } catch (error) {
    if (!isBubblewrapUsernsFailure(errorMessage(error))) return direct;
  }

  const aaExec = "/usr/bin/aa-exec";
  for (const profile of APPARMOR_USERNS_PROFILES) {
    try {
      await runCommand(aaExec, ["-p", profile, "--", options.binaryPath, ...probeArgs], {
        cwd: options.cwd,
        env: options.env,
      });
      return {
        executable: aaExec,
        args: ["-p", profile, "--", options.binaryPath, ...options.args],
        appArmorProfile: profile,
      };
    } catch {
      // The profile may not be installed or may not permit user namespaces.
    }
  }

  return direct;
}

function isBubblewrapUsernsFailure(message: string): boolean {
  return BWRAP_USERNS_FAILURES.some((fragment) => message.includes(fragment));
}
