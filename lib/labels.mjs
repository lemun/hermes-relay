export const LABELS = Object.freeze({
  NEEDS_GRILL: "needs-grill",
  GRILLING: "grilling",
  WAITING_INPUT: "waiting-input",
  READY: "ready",
  IMPLEMENTING: "implementing",
  PR_OPEN: "pr-open",
  FINISHING: "finishing",
  BLOCKED: "blocked",
  SUPERSEDED: "superseded",
  ENGINE_CODEX: "engine:codex",
  ENGINE_CLAUDE: "engine:claude",
});

export const ENGINE_LABELS = Object.freeze([
  LABELS.ENGINE_CODEX,
  LABELS.ENGINE_CLAUDE,
]);

export const REQUIRED_REPO_LABELS = Object.freeze([
  {
    name: LABELS.NEEDS_GRILL,
    description: "Needs owner/product grilling before dispatch",
    color: "FBCA04",
  },
  {
    name: LABELS.GRILLING,
    description: "Grilling session in flight",
    color: "C5DEF5",
  },
  {
    name: LABELS.WAITING_INPUT,
    description: "Owner input pending for a Hermes session",
    color: "B60205",
  },
  {
    name: LABELS.READY,
    description: "Ready for implementation",
    color: "0E8A16",
  },
  {
    name: LABELS.IMPLEMENTING,
    description: "Implementation session in flight",
    color: "1D76DB",
  },
  {
    name: LABELS.PR_OPEN,
    description: "Pull request open, awaiting Hermes finisher",
    color: "5319E7",
  },
  {
    name: LABELS.FINISHING,
    description: "Finisher pipeline in flight",
    color: "006B75",
  },
  {
    name: LABELS.BLOCKED,
    description: "Blocked pending dependency or owner action",
    color: "D93F0B",
  },
  {
    name: LABELS.SUPERSEDED,
    description: "Superseded by successor issue(s)",
    color: "BFDADC",
  },
  {
    name: LABELS.ENGINE_CODEX,
    description: "Use Codex for this issue",
    color: "0E8A16",
  },
  {
    name: LABELS.ENGINE_CLAUDE,
    description: "Use Claude for this issue",
    color: "5319E7",
  },
]);

export function requiredLabelNames() {
  return REQUIRED_REPO_LABELS.map((label) => label.name);
}

export function missingRequiredLabels(existingNames, required = REQUIRED_REPO_LABELS) {
  const existing = new Set(existingNames || []);
  return required.filter((label) => !existing.has(label.name));
}
