import { spawn } from "node:child_process";
import { CodeSyncError } from "./code-sync.js";

export type GitHubAuthCommand = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;

/** Only a local user action may call this. No device code or token is returned to GT. */
export async function connectGitHubAccount(command: GitHubAuthCommand = runGitHubAuthCommand, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const connected = await command(["auth", "status", "--hostname", "github.com"], 10_000, signal);
  signal?.throwIfAborted();
  if (connected) return;
  const signedIn = await command(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"], 240_000, signal);
  signal?.throwIfAborted();
  const verified = signedIn && await command(["auth", "status", "--hostname", "github.com"], 10_000, signal);
  signal?.throwIfAborted();
  if (!verified) {
    throw new CodeSyncError("github_auth_failed", "GitHub sign-in was not completed on this device. Reopen the connection and finish in your browser.");
  }
}

export function runGitHubAuthCommand(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Never inherit an environment token: the browser flow must establish the
    // device's own durable GitHub CLI login, not a temporary process secret.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_PROMPT_DISABLED"].includes(key)));
    const child = spawn("gh", [...args], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    let settled = false, stopping = false;
    let force: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); clearTimeout(deadline); signal?.removeEventListener("abort", stop); };
    const finish = (value: boolean) => {
      if (settled) return; settled = true; cleanup();
      if (signal?.aborted) reject(signal.reason); else resolve(value);
    };
    const stop = () => {
      if (settled || stopping) return; stopping = true;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 750);
      deadline = setTimeout(() => {
        if (settled) return; settled = true; cleanup();
        reject(new CodeSyncError("github_auth_failed", "GitHub sign-in did not exit; close its local process before reconnecting."));
      }, 3000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true; cleanup();
      reject(new CodeSyncError(error.code === "ENOENT" ? "github_cli_unavailable" : "github_auth_failed",
        error.code === "ENOENT" ? "Install GitHub CLI on this device before connecting." : "GitHub CLI could not start on this device."));
    });
    child.on("exit", (code) => finish(!stopping && code === 0));
  });
}
