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

export type CommitPushResult = {
  ok: boolean;
  // Each step records what happened; even on success there may be a
  // useful note (e.g. "nothing to commit").
  steps: Array<{ step: string; exitCode: number; output: string }>;
};

export async function commitPush(
  root: string,
  message: string
): Promise<CommitPushResult> {
  if (!message.trim()) throw new Error("commit message required");
  const steps: CommitPushResult["steps"] = [];

  // 1. stage everything inside the project root
  const add = await execa("git", ["add", "-A"], { cwd: root, reject: false });
  steps.push({
    step: "git add -A",
    exitCode: add.exitCode ?? 1,
    output: combine(add),
  });
  if (add.exitCode !== 0) return { ok: false, steps };

  // 2. commit; if there's nothing to commit, surface that as a non-error
  //    so the UI can say "nothing changed" instead of looking broken
  const commit = await execa(
    "git",
    ["commit", "-m", message, "--no-verify"],
    { cwd: root, reject: false }
  );
  const commitOutput = combine(commit);
  steps.push({
    step: "git commit",
    exitCode: commit.exitCode ?? 1,
    output: commitOutput,
  });
  if (commit.exitCode !== 0) {
    const empty = /nothing to commit|no changes added/i.test(commitOutput);
    return { ok: empty, steps };
  }

  // 3. push to whatever the current branch tracks
  const push = await execa("git", ["push"], { cwd: root, reject: false });
  steps.push({
    step: "git push",
    exitCode: push.exitCode ?? 1,
    output: combine(push),
  });
  return { ok: push.exitCode === 0, steps };
}

function combine(r: { stdout: unknown; stderr: unknown }): string {
  const out = String(r.stdout ?? "").trim();
  const err = String(r.stderr ?? "").trim();
  if (out && err) return `${out}\n${err}`;
  return out || err;
}

export type RememberResult = {
  ok: boolean;
  // The id of the persisted memory if available (parsed out of baton's
  // stdout). Falls back to null when baton's output format changes.
  id: number | null;
  output: string;
};

export async function rememberNote(
  batonBin: string,
  text: string,
  opts: { tags?: string[]; project?: string | null } = {}
): Promise<RememberResult> {
  if (!text.trim()) throw new Error("note text is empty");
  const args = ["remember", text];
  if (opts.tags && opts.tags.length) {
    args.push("--tags", opts.tags.join(","));
  }
  if (opts.project) {
    args.push("--project", opts.project);
  }
  // BATON_BIN may be a path to a script (e.g. "node /path/dist/cli/index.js")
  // — split on whitespace so the env var can include args. shell-quoting
  // is the user's responsibility; we don't pass user input through shell.
  const [cmd, ...prefixArgs] = batonBin.split(/\s+/).filter(Boolean);
  if (!cmd) throw new Error("BATON_BIN not configured");
  const r = await execa(cmd, [...prefixArgs, ...args], { reject: false });
  const out = (String(r.stdout) + "\n" + String(r.stderr)).trim();
  const idMatch = out.match(/id=(\d+)/);
  return {
    ok: r.exitCode === 0,
    id: idMatch ? Number(idMatch[1]) : null,
    output: out,
  };
}

export async function probeBaton(batonBin: string): Promise<boolean> {
  try {
    const [cmd, ...prefixArgs] = batonBin.split(/\s+/).filter(Boolean);
    if (!cmd) return false;
    const r = await execa(cmd, [...prefixArgs, "--version"], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
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
