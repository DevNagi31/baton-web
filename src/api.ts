import { execa } from "execa";
import { readFile, stat } from "node:fs/promises";
import { resolve as pathResolve, sep } from "node:path";

export type StatusEntry = {
  path: string;
  // index = staged column (X), worktree = unstaged column (Y).
  // Common values: "M" (modified), "A" (added), "D" (deleted),
  // "R" (renamed), "?" (untracked).
  index: string;
  worktree: string;
};

export type TreeFile = {
  path: string;
  // Optional status badge for files that have changes (so the tree can
  // show a dot/dirty indicator without an extra round-trip).
  status?: string;
};

const FILE_BYTE_CAP = 2 * 1024 * 1024; // 2MB — refuse larger files

// Resolve a user-supplied path to an absolute path inside `root`.
// Throws if the resulting path escapes `root` (path traversal). Returns
// the validated absolute path.
function safeResolve(root: string, relPath: string): string {
  const abs = pathResolve(root, "." + (relPath.startsWith("/") ? relPath : "/" + relPath));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error("path-traversal");
  }
  return abs;
}

export async function getStatus(root: string): Promise<StatusEntry[]> {
  const r = await execa("git", ["status", "--porcelain=v1", "-uall", "-z"], {
    cwd: root,
    reject: false,
  });
  if (!r.stdout) return [];
  const out: StatusEntry[] = [];
  for (const entry of String(r.stdout).split("\0")) {
    if (entry.length < 4) continue;
    out.push({
      index: entry[0],
      worktree: entry[1],
      path: entry.slice(3),
    });
  }
  return out;
}

export async function listTree(root: string): Promise<TreeFile[]> {
  const tracked = await execa("git", ["ls-files", "-z"], {
    cwd: root,
    reject: false,
  });
  const untracked = await execa(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root, reject: false }
  );
  const set = new Set<string>();
  for (const part of String(tracked.stdout).split("\0")) {
    if (part) set.add(part);
  }
  for (const part of String(untracked.stdout).split("\0")) {
    if (part) set.add(part);
  }

  const status = await getStatus(root);
  const statusMap = new Map<string, string>();
  for (const s of status) {
    const code = (s.index !== " " ? s.index : s.worktree).trim();
    statusMap.set(s.path, code);
  }

  return [...set]
    .sort()
    .map((p) => ({ path: p, status: statusMap.get(p) }));
}

export async function readFileSafely(
  root: string,
  relPath: string
): Promise<{ content: string; bytes: number }> {
  const abs = safeResolve(root, relPath);
  const s = await stat(abs);
  if (!s.isFile()) throw new Error("not-a-file");
  if (s.size > FILE_BYTE_CAP) {
    return {
      content: `[file ${s.size} bytes — exceeds ${FILE_BYTE_CAP} cap; view via terminal]`,
      bytes: s.size,
    };
  }
  const buf = await readFile(abs);
  // Refuse anything that smells binary (NUL bytes in the first 2KB).
  const sniff = buf.subarray(0, Math.min(buf.length, 2048));
  if (sniff.includes(0)) {
    return {
      content: `[binary file — ${s.size} bytes — not displayable]`,
      bytes: s.size,
    };
  }
  return { content: buf.toString("utf8"), bytes: s.size };
}

export async function getDiff(
  root: string,
  relPath: string
): Promise<{ diff: string; mode: "unstaged" | "untracked" | "no-change" }> {
  // Validate the path lives inside root before passing it to git
  safeResolve(root, relPath);

  // Untracked files have no diff in git's eyes — surface a synthetic
  // "all-additions" diff so the panel still renders something useful.
  const status = await execa(
    "git",
    ["status", "--porcelain=v1", "--", relPath],
    { cwd: root, reject: false }
  );
  const line = String(status.stdout).split("\n")[0]?.trim() ?? "";
  const isUntracked = line.startsWith("??");

  if (isUntracked) {
    const { content } = await readFileSafely(root, relPath);
    const synthetic = content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    return {
      diff: `diff --git a/${relPath} b/${relPath}\nnew file\n--- /dev/null\n+++ b/${relPath}\n${synthetic}`,
      mode: "untracked",
    };
  }

  const r = await execa(
    "git",
    ["diff", "--no-color", "HEAD", "--", relPath],
    { cwd: root, reject: false }
  );
  const diff = String(r.stdout);
  if (!diff.trim()) return { diff: "", mode: "no-change" };
  return { diff, mode: "unstaged" };
}
