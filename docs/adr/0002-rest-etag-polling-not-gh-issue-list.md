# Poll GitHub with raw REST + ETags, not `gh issue list`

`gh issue list` is GraphQL under the hood (verified with GH_DEBUG=api): every call costs shared GraphQL budget and can never return a free 304, because conditional requests don't exist for POST. The poller instead does one `gh api` REST GET per repo (`repos/{r}/issues?state=open&per_page=100`) with `If-None-Match`, filters labels locally, and treats 304 as "nothing changed" at zero rate-limit cost (docs.github.com REST best-practices, verified 2026-07-06). Cadence is adaptive: ~30s while sessions are in flight or questions are pending, ~3min idle, guarded by the free `rate_limit` endpoint and retry-after on 403/429.

Do not "simplify" this back to the porcelain command — that reintroduces the GraphQL budget drain (~29%/hr at 30s across 2 repos) on an account shared with other agents.

Related constraint from the same research: GitHub never documents whether PATCH-editing an existing comment counts against the content-creation secondary limit (80/min, 500/hr), so ledger-comment edits are coalesced (≥5–10s apart, comfortably under 500/hr) rather than written on every state change.
