#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyInstall,
  applyRetention,
  installPaths,
  lintPlists,
  planRetention,
  renderInstallArtifacts,
  validateLiveRoot,
} from "../lib/install-update.mjs";

const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log("Usage: node scripts/install-update.mjs --root /absolute/live/root [--dry-run|--apply] [--allow-worktree] [--prune --retention-days DAYS]");
}

const args = process.argv.slice(2);
let root = "";
let apply = false;
let allowWorktree = false;
let prune = false;
let retentionDays = 14;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--root") root = args[++i] || "";
  else if (arg === "--apply") apply = true;
  else if (arg === "--dry-run") apply = false;
  else if (arg === "--allow-worktree") allowWorktree = true;
  else if (arg === "--prune") prune = true;
  else if (arg === "--retention-days") retentionDays = Number(args[++i]);
  else { usage(); process.exitCode = 2; }
}

if (!process.exitCode) {
  try {
    const liveRoot = validateLiveRoot(root, { allowWorktree });
    const artifacts = renderInstallArtifacts({ templateRoot: TEMPLATE_ROOT, liveRoot });
    const paths = installPaths({ liveRoot });
    // Validate the whole requested operation before any --apply write, so a
    // malformed retention option cannot leave an installation half-updated.
    const retention = prune ? planRetention({ root: liveRoot, retentionDays }) : null;
    const plutilLinted = lintPlists(artifacts.plists);
    if (apply && !plutilLinted) throw new Error("plutil is required to apply rendered launchd plists; run this command on macOS");

    console.log(`Live root: ${liveRoot}`);
    console.log(plutilLinted ? "plutil: OK" : "plutil: unavailable (dry-run only; run on macOS before apply)");
    for (const plist of artifacts.plists) console.log(`${apply ? "Render" : "Would render"}: ${path.join(paths.launchAgents, plist.name)}`);
    console.log(`${apply ? "Render" : "Would render"}: ${paths.mcp}`);

    if (!apply) {
      console.log("Dry run: no files were changed.");
    } else {
      const backups = applyInstall({ artifacts, paths });
      console.log(`Rendered ${artifacts.plists.length} LaunchAgent plist(s) and MCP config.`);
      console.log(backups.length ? `Rollback backups: ${backups.join(", ")}` : "Rollback backups: none (no prior rendered files).");
    }
    if (retention) {
      for (const file of retention.serviceLogs) console.log(`${apply ? "Prune" : "Would prune"} service log: ${file}`);
      for (const session of retention.completedSessions) console.log(`${apply ? "Prune" : "Would prune"} completed session: ${session.id}`);
      for (const id of retention.protectedSessions) console.log(`Protect active session: ${id}`);
      if (retention.skippedSessionPrune) console.log("Protect sessions: state file missing or unreadable; no session artifacts will be pruned.");
      if (apply) applyRetention(retention);
      if (!retention.serviceLogs.length && !retention.completedSessions.length) console.log("Retention: nothing eligible for pruning.");
    }
    console.log("Next: review the rendered files, then run launchctl bootout/bootstrap or kickstart yourself if the service needs reloading.");
  } catch (err) {
    console.error(`Install/update refused: ${err.message}`);
    process.exitCode = 1;
  }
}
