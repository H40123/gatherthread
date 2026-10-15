import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { IdSchema } from "@gatherthread/protocol";

/** Proof of local quiescence, never a native task, transcript or credential. */
export interface SharedStoppedReceipt {
  version: 1; jobId: string; claimAttempt: number; sourceRuntimeId: string; projectId: string; ownerDeviceId: string;
}
export type SharedStoppedScope = Pick<SharedStoppedReceipt, "sourceRuntimeId" | "projectId" | "ownerDeviceId">;

/** Private single-owner atomic outbox. Unknown orphan work never gets a receipt. */
export class SharedStoppedReceiptOutbox {
  readonly #directory: string; readonly #root: string;
  constructor(privateStateRoot: string) {
    if (!path.isAbsolute(privateStateRoot)) throw new Error("Shared execution control state must have an absolute private path");
    this.#root = privateStateRoot; this.#directory = path.join(privateStateRoot, "stopped-receipts");
  }
  async list(scope: SharedStoppedScope): Promise<SharedStoppedReceipt[]> {
    await this.#prepare();
    const names = (await readdir(this.#directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
    if (names.length > 256) throw new Error("Shared cleanup outbox exceeds its bound");
    const receipts: SharedStoppedReceipt[] = [];
    for (const name of names) {
      const file = await open(path.join(this.#directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 2048 || (info.mode & 0o077) !== 0) throw new Error("Invalid private shared cleanup receipt");
        const receipt = parseReceipt(JSON.parse(await file.readFile("utf8")));
        if (receipt.sourceRuntimeId !== scope.sourceRuntimeId || receipt.projectId !== scope.projectId || receipt.ownerDeviceId !== scope.ownerDeviceId
          || path.basename(this.#path(receipt)) !== name) throw new Error("Shared cleanup receipt scope mismatch");
        receipts.push(receipt);
      } finally { await file.close(); }
    }
    return receipts;
  }
  async put(input: SharedStoppedReceipt): Promise<void> {
    const receipt = parseReceipt(input); await this.#prepare();
    const final = this.#path(receipt), temporary = `${final}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${JSON.stringify(receipt)}\n`); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, final); await this.#syncDirectory(); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  async remove(receipt: SharedStoppedReceipt): Promise<void> {
    await this.#prepare();
    await unlink(this.#path(parseReceipt(receipt))).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    await this.#syncDirectory();
  }
  #path(receipt: SharedStoppedReceipt): string {
    return path.join(this.#directory, `${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}.json`);
  }
  async #prepare(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Shared cleanup root must be a private directory");
    await chmod(this.#root, 0o700);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Shared cleanup state must be a private directory");
    await chmod(this.#directory, 0o700);
  }
  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

function parseReceipt(value: unknown): SharedStoppedReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared cleanup receipt");
  const input = value as Record<string, unknown>;
  const fields = ["version", "jobId", "claimAttempt", "sourceRuntimeId", "projectId", "ownerDeviceId"];
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) || input.version !== 1
    || !Number.isSafeInteger(input.claimAttempt) || (input.claimAttempt as number) < 1 || (input.claimAttempt as number) > 1000) throw new Error("Invalid shared cleanup receipt");
  return { version: 1, jobId: IdSchema.parse(input.jobId), claimAttempt: input.claimAttempt as number,
    sourceRuntimeId: IdSchema.parse(input.sourceRuntimeId), projectId: IdSchema.parse(input.projectId), ownerDeviceId: IdSchema.parse(input.ownerDeviceId) };
}
