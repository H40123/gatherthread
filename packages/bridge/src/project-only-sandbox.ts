import { execFile, spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

export const SHARED_CODEX_PERMISSION_PROFILE = "gatherthread-shared-project";
export async function validateSharedProjectRoots(workspace: string, control: string): Promise<{ workspacePath: string; controlPath: string }> {
  const workspacePath = await realpath(workspace);
  if (!path.isAbsolute(workspacePath) || workspacePath === path.parse(workspacePath).root || !(await stat(workspacePath)).isDirectory()) throw new Error("Shared Agent needs an explicit project directory");
  await mkdir(control, { recursive: true, mode: 0o700 });
  const controlPath = await realpath(control);
  const relative = path.relative(workspacePath, controlPath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Shared Agent control data must remain outside the project directory");
  return { workspacePath, controlPath };
}

/** Fresh native home; no owner config, native history, Hooks, skills or MCP. */
export function sharedCodexConfiguration(): string {
  return `approval_policy = "never"
default_permissions = "${SHARED_CODEX_PERMISSION_PROFILE}"
web_search = "disabled"
project_doc_max_bytes = 0
[shell_environment_policy]
inherit = "none"
[features]
apps = false
hooks = false
shell_tool = false
goals = false
unified_exec = false
shell_snapshot = false
code_mode = false
code_mode_host = false
code_mode_only = false
multi_agent = false
multi_agent_v2 = false
browser_use = false
computer_use = false
use_legacy_landlock = false
[apps._default]
enabled = false
[permissions.${SHARED_CODEX_PERMISSION_PROFILE}]
extends = ":workspace"
[permissions.${SHARED_CODEX_PERMISSION_PROFILE}.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
[permissions.${SHARED_CODEX_PERMISSION_PROFILE}.filesystem.":workspace_roots"]
"." = "write"
".git" = "deny"
".agents" = "deny"
".codex" = "deny"
".aws" = "deny"
[permissions.${SHARED_CODEX_PERMISSION_PROFILE}.network]
enabled = false
`;
}

export interface ProjectFileOperation { action: "list" | "read" | "write"; path: string; content?: string; }
/** Native openat/O_NOFOLLOW directory walks; no model-controlled subprocess. */
export class ProjectOnlyFileAccess {
  readonly #root: string; readonly #python: string;
  constructor(root: string, python = "python3") { this.#root = root; this.#python = python; }
  async preflight(): Promise<boolean> {
    if (process.platform === "win32") return false;
    try {
      const result = await run(this.#python, ["-c", "import os; print('ready' if os.open in os.supports_dir_fd and hasattr(os,'O_NOFOLLOW') and hasattr(os,'O_DIRECTORY') else 'unsupported')"],
        { timeout: 4000, maxBuffer: 1024, env: { PATH: process.env.PATH } });
      return result.stdout.trim() === "ready";
    } catch { return false; }
  }
  async execute(operation: ProjectFileOperation, signal?: AbortSignal): Promise<{ content: string }> {
    if (!operation.path || operation.path.includes("\0") || path.isAbsolute(operation.path)
      || operation.path.split(/[\\/]/u).some(part => part === ".." || part === "")
      || !["list", "read", "write"].includes(operation.action)
      || (operation.content !== undefined && Buffer.byteLength(operation.content) > 64 * 1024)) throw new Error("Invalid project file operation");
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.#python, ["-c", PROJECT_FILES_HELPER], { shell: false,
        env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore"], ...(signal === undefined ? {} : { signal }) });
      let output = "", settled = false, operationError: Error | undefined;
      const timeout = setTimeout(() => { operationError = new Error("Project file operation timed out"); child.kill("SIGKILL"); }, 5000); timeout.unref();
      function finish(error?: Error, result?: { content: string }) { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(result!); }
      child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); if (Buffer.byteLength(output) > 512 * 1024) { operationError = new Error("Project file output exceeded limit"); child.kill("SIGKILL"); } });
      child.once("error", () => {
        operationError = new Error("Project file operation unavailable");
        if (child.pid === undefined) finish(operationError);
      });
      child.once("close", code => {
        if (operationError || code !== 0 || signal?.aborted) return finish(operationError ?? new Error("Project file operation refused"));
        try { const result = JSON.parse(output); if (typeof result.content !== "string") throw new Error(); finish(undefined, { content: result.content }); }
        catch { finish(new Error("Invalid project file result")); }
      });
      child.stdin.end(JSON.stringify({ ...operation, root: this.#root }));
    });
  }
}

// The root descriptor and every descendant directory are opened without following
// links. Hard-linked files and credential/control directories are refused. The
// helper has no shell, network or provider credential; paths never become code.
const PROJECT_FILES_HELPER = String.raw`
import os,sys,json,stat
v=json.load(sys.stdin)
parts=v['path'].replace('\\','/').split('/')
def blocked(name):
 name=name.lower()
 if name.startswith('.env') and name not in ('.env.example','.env.sample'):
  if name=='.env' or name.startswith('.env.'): return True
 return name in ('','..','.git','.codex','.agents','.aws','.ssh','.kube','.config','.docker','.gcloud','.azure',
  '.netrc','.npmrc','.pypirc','.git-credentials','auth.json','auth.yaml','auth.yml',
  '.credentials.yaml','.credentials.yml','.credentials.json','credentials.json','credentials.yaml','credentials.yml',
  'credentials','tokens.json','token.json','kubeconfig','id_rsa','id_dsa','id_ecdsa','id_ed25519')
if any(blocked(p) for p in parts): raise ValueError('path')
if '.' in parts and parts != ['.']: raise ValueError('path')
fds=[]
try:
 root=os.open(v['root'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(root)
 parent=root
 for part in parts[:-1]:
  parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent); fds.append(parent)
 name=parts[-1]
 action=v['action']
 if action=='list':
  fd=root if parts==['.'] else os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
  if fd!=root: fds.append(fd)
  names=[]
  for entry in sorted(os.listdir(fd)):
   if blocked(entry): continue
   info=os.stat(entry,dir_fd=fd,follow_symlinks=False)
   if stat.S_ISLNK(info.st_mode): continue
   names.append(entry+('/' if stat.S_ISDIR(info.st_mode) else ''))
   if len(names)>1024: raise ValueError('limit')
  result='\n'.join(names)
 elif action=='read':
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent); fds.append(fd)
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>65536: raise ValueError('file')
  data=os.read(fd,65537)
  if len(data)>65536: raise ValueError('limit')
  result=data.decode('utf-8')
 elif action=='write':
  data=v['content'].encode('utf-8')
  if len(data)>65536: raise ValueError('limit')
  try: fd=os.open(name,os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  except FileNotFoundError: fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
  fds.append(fd); info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise ValueError('file')
  os.ftruncate(fd,0)
  while data:
   count=os.write(fd,data); data=data[count:]
  os.fsync(fd); result='Saved project file.'
 else: raise ValueError('action')
 print(json.dumps({'content':result},ensure_ascii=True))
finally:
 for fd in reversed(fds): os.close(fd)
`;
