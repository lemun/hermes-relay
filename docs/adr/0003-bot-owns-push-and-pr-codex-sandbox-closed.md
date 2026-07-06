# The bot pushes branches and opens PRs; codex runs with network off

The local Codex CLI sandbox has no per-domain network allowlist (that exists only in Codex Cloud): `workspace-write` network is all-or-nothing, and the execpolicy rules escape hatch is explicitly experimental and runs git/gh fully unsandboxed. So implementation sessions run `codex exec -s workspace-write -c approval_policy=never` with `network_access=false`, and Hermes itself performs `git push` + `gh pr create` from the worktree after the session exits, then updates the ledger comment with the PR link.

Consequences: a prompt-injected implementer can't exfiltrate over the network; PR creation and issue-linking are uniform across engines because the hub owns them; codex cannot iterate against live CI (CI triage is a separate finisher-pipeline step, which was already the design). Verified against developers.openai.com/codex/concepts/sandboxing and live flag tests on codex-cli 0.142.5, 2026-07-06.
