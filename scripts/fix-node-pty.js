#!/usr/bin/env node
// node-pty's npm tarball ships spawn-helper without the executable bit
// in some package versions, causing posix_spawnp to fail with no useful
// error. Restore +x on every prebuild so the runtime can actually exec
// the helper.
//
// Run automatically as a postinstall hook in package.json. Safe to run
// multiple times; idempotent.

import { chmodSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PREBUILDS = "node_modules/node-pty/prebuilds";

function fixDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // node-pty not installed (peer-dep skip, etc.)
  }
  for (const platform of entries) {
    const helper = join(dir, platform, "spawn-helper");
    try {
      const s = statSync(helper);
      // 0o755 — owner rwx, group/other rx
      if ((s.mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        console.log(`[fix-node-pty] +x ${helper}`);
      }
    } catch {
      // No spawn-helper for this platform (e.g. windows). Skip.
    }
  }
}

fixDir(PREBUILDS);
