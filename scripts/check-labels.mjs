#!/usr/bin/env node

import { createRepoLabel, listRepoLabels } from "../lib/gh.mjs";
import { missingRequiredLabels, REQUIRED_REPO_LABELS, requiredLabelNames } from "../lib/labels.mjs";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const slug = argValue("--repo") || process.env.HERMES_LABEL_REPO || "lemun/hermes-relay";
const apply = process.argv.includes("--apply");

async function main() {
  const before = await listRepoLabels({ slug });
  let missing = missingRequiredLabels(before.map((label) => label.name));

  if (missing.length && !apply) {
    console.error(`Missing required labels for ${slug}: ${missing.map((label) => label.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  for (const label of missing) {
    await createRepoLabel({ slug, ...label });
    console.log(`created ${label.name}`);
  }

  const after = await listRepoLabels({ slug });
  missing = missingRequiredLabels(after.map((label) => label.name));
  if (missing.length) {
    console.error(`Missing required labels for ${slug}: ${missing.map((label) => label.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`All required labels present for ${slug}: ${requiredLabelNames().join(", ")}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
