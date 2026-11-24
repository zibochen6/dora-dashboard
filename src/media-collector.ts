import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import script from "./media-browser.ego";
import type { Batch, Cursor, Platform } from "./media.ts";

export interface ScanJob {
  space: string;
  profileId: string;
  accountId: string;
  platform: Platform;
  cursor: Cursor;
  day: string;
}
export interface Collector {
  step(job: ScanJob, signal: AbortSignal): Promise<Batch>;
  close(space: string): Promise<void>;
}
export interface EgoProfile {
  id: string;
  name: string;
}
export interface CreatorIdentity {
  id: string;
  name: string;
}
type BrowserJob =
  | (ScanJob & { reload?: boolean })
  | { profiles: true }
  | { space: string; identify: true; platform: Platform; profileId: string }
  | { space: string; close: true };
const marker = "DORA_MEDIA_RESULT ";
function execute(
  executable: string,
  source: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ["nodejs"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout,
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(source);
  });
}
async function invoke<T>(job: BrowserJob, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const timeout = "close" in job || "profiles" in job ? 15000 : 180000;
  const source =
    script +
    "\ntry { const result=await mediaStep(" +
    JSON.stringify(job) +
    "); console.log(" +
    JSON.stringify(marker) +
    "+JSON.stringify({result})); } catch (e) { console.log(" +
    JSON.stringify(marker) +
    "+JSON.stringify({error:String(e.message).split('\\n')[0].slice(0,180)})); }";
  const names =
    process.platform === "darwin"
      ? [
          "ego-browser",
          join(homedir(), ".local", "bin", "ego-browser"),
          "/opt/homebrew/bin/ego-browser",
          "/usr/local/bin/ego-browser",
        ]
      : ["ego-browser"];
  for (const name of names) {
    let out: string;
    try {
      out = await execute(name, source, timeout, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      signal?.throwIfAborted();
      throw new Error(
        "Ego Lite could not complete the request. Open the browser and retry.",
      );
    }
    const line = out.split(/\r?\n/).find((l) => l.startsWith(marker));
    if (!line) throw new Error("Ego Lite returned no result.");
    const value = JSON.parse(line.slice(marker.length));
    if (value.error) throw new Error(value.error);
    return value.result;
  }
  throw new Error(
    "Ego Lite is unavailable. Install it, complete onboarding and open the browser.",
  );
}
export function listProfiles(signal: AbortSignal): Promise<EgoProfile[]> {
  return invoke({ profiles: true }, signal);
}

export async function identifyAccount(
  platform: Platform,
  profileId: string,
  signal: AbortSignal,
): Promise<CreatorIdentity> {
  if (!profileId) throw new Error("Choose an Ego Lite profile first.");
  signal.throwIfAborted();
  const space = "Dora Dashboard · " + randomUUID();
  try {
    return await invoke<CreatorIdentity>(
      { space, identify: true, platform, profileId },
      signal,
    );
  } finally {
    // A cancelled or timed-out CLI process can leave its browser space behind.
    await invoke({ space, close: true }).catch(() => {});
  }
}
export const egoCollector: Collector = {
  async step(job, signal) {
    try {
      return await invoke<Batch>(job, signal);
    } catch (error) {
      // Ego stops a stalled navigation. A fresh SDK round can safely reread the same page.
      if (
        signal.aborted ||
        !(error instanceof Error) ||
        !/did not answer|navigation had started|timed out|后台页面未返回预期数据|execution timed out/i.test(
          error.message,
        )
      )
        throw error;
      return invoke<Batch>({ ...job, reload: true }, signal);
    }
  },
  close: async (space) => {
    await invoke({ space, close: true });
  },
};
