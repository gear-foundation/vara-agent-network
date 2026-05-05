# TODO

Deferred work, with explicit disclosure of impact. PR #23 lands the autonomous consumer loop in B+ shape (scripts/ as runtime, .md as docs). The items below are explicitly out of scope for that PR; they are tracked here so future contributors do not rediscover them as "missing."

## P1 — next-PR fast-follow

- **Producer-side autonomous skills.** Closes the ~25% leaderboard-weight gap. Skills required: `agent-market-gap`, `agent-integration-planning`, `agent-product-evolution`, `agent-program-evolution`. Each must have its own `scripts/*.sh` runtime under the same B+ shape. Disclosed in `references/season-economy.md`.
- **HALTED escalation hook.** Currently `scripts/autonomous-loop.sh` logs the HALTED transition to `loop-history.jsonl` and stderr only. Webhook (Slack / PagerDuty / arbitrary HTTP) deferred P2.
- **Durable announcement cursor.** `agent-mentions-listener.md` has cursor durability for mentions; announcements use a non-durable in-memory cursor for v1. Ring-buffer + cursor in v1.1.

## P2 — quality, not blockers

- **`reconciliation.jsonl` rotation/retention.** Append-only, persistent for the season. Acceptable until end-of-season demo; rotation is a v1.1 ergonomics concern, not a correctness one.
- **`gtest` / `sails-local-smoke` wired into the loop.** Producer-side testing — not consumer scope.
- **Cross-machine state sync.** Single-machine multi-process is in scope (`loop.lock`); multi-machine is not. Lint warns when `vara-wallet account` is locked under another `STATE_DIR` (P1-C11).
- **Producer-side P2 cleanups carried over from PR #21 codex review.** Orthogonal.
- **Indexer plumbing for `valuePaidRaw` / `totalValuePaidRaw`.** Consumer-first redesign deferred; rank inputs are derived from `integrationsIn` + recon errors + latency until indexer exposes the per-target spend column.
- **Same-wallet / different-`STATE_DIR`** (P1-C11). Operator footgun. Lint warning only; no script-layer enforcement is possible without daemon coordination.

## Out-of-scope, explicit non-goals

- **Twitter/X social posting integration** (PDF Phase 5). Separate skill domain; not started.
- **Pre-mainnet checklist** (archive RPC selection, PostGraphile auth, `HACKATHON_*` env sunset). See `references/program-ids.md`.

## Cross-PR dependencies

- **Seed-backend funding flow** (PR #25). The autonomous loop assumes the seed-backend exists and provides `INITIAL_TARGET_VARA = 5`, `REFILL_TARGET_VARA = 5`, 24h refill cooldown, and a suspicious-spend monitor. Code references in this branch quote the design but do not link to a vendored copy of `services/seed-backend/README.md`; once PR #25 lands, those references resolve.
