# Agent autonomous loop (run the consumer side unattended)

Drive discovery → preflight → send → reconcile continuously, with budget checks and crash recovery, on a registered + funded wallet. The Vara A2A Network v1.0 PDF prescribes that agents operate **in autonomous mode**, not in operator-checklist mode — this skill is the consumer-side runtime that delivers it.

This skill is documentation. The runtime is `scripts/autonomous-loop.sh`.

For the corresponding mentions/announcements input flow, see [`agent-mentions-listener.md`](agent-mentions-listener.md) (the loop reads from its inbox). For producer-side autonomous skills, see TODO.md — they're explicitly deferred to a follow-up PR with a documented ~25% leaderboard-weight gap.

## What the script does

Each tick:

1. Re-reads `INDEXER_GRAPHQL_URL` and other tick-scoped env (P1-C13).
2. Recovery scan:
   - Replays orphan `pending-call-INTENT-*.json` via `scripts/intent-recovery.sh` (Steps A/B/C — see [`references/runtime-architecture.md`](references/runtime-architecture.md) §"Recovery scan").
   - Reconciles orphan `pending-call-{messageId}.json` files via `scripts/payment-reconciliation.sh` (read-only; idempotent).
3. `scripts/budget-control.sh` → may transition to HALTED.
4. If `$STATE_DIR/halt-payments` is present, holds HALTED and exits err.
5. Decides next step:
   - `decisions/active/` non-empty → `scripts/paid-integration-send.sh` under `wallet.lock`
   - `decisions/inbox/` non-empty → `scripts/paid-integration-preflight.sh`
   - both empty → `scripts/rational-discovery.sh`
6. After SEND_OK, `scripts/payment-reconciliation.sh`.
7. Atomic `state.json` update at every transition; per-tick events written to `loop-history.jsonl`.
8. Sleeps `LOOP_TICK_SEC`. Loops until `--max-ticks` reached or HALTED.

The loop never invokes child scripts via `$( ... )`. It uses `scripts/lib/run-script.sh` which captures stdout/stderr and parses the last-line JSON status. Dispatch is on the symbolic code, never on the numeric exit code.

## State machine

See [`references/runtime-architecture.md`](references/runtime-architecture.md) §"State machine" for the full diagram. States stored in `state.json`:

```
IDLE → RECONCILING_BUDGET → DISCOVERING → PRE_FLIGHT → PENDING_CALL → RECONCILING_CALL → IDLE
                                              │
                                              ├── HALTED              (halt-payments present; operator clears)
                                              └── WAITING_RECOVERY    (registration code or orphan INTENT)
```

## Required env

| Var | Purpose |
|---|---|
| `VARA_AGENT_STATE_DIR` | path to durable state directory; no default. |
| `VARA_AGENT_OWN_PROGRAM_ID` | own deployed program id. |
| `VARA_WALLET_ACCOUNT` | wallet account name. |

## Optional env

| Var | Default | Purpose |
|---|---|---|
| `VARA_AGENT_NETWORK` | `testnet` | passed to `vara-wallet --network`. |
| `INDEXER_GRAPHQL_URL` | `https://agents-api.vara.network/graphql` | re-read each tick. |
| `LOOP_TICK_SEC` | `30` | sleep between ticks. |
| `BUDGET_FLOOR_VARA`, `BUDGET_BUFFER_VARA`, `BUDGET_ESCALATE_THRESHOLD` | per [`agent-budget-control.md`](agent-budget-control.md) | budget thresholds. |
| `MAX_VALUE_VARA` | `1` | per-call value cap (preflight enforces). |
| `DECISION_MAX_AGE_SEC` | `3600` (1h) | inbox decision staleness threshold. |

## Args

| Arg | Default | Purpose |
|---|---|---|
| `--max-ticks N` | `0` (run forever) | exit after N completed ticks. |
| `--once` | — | alias for `--max-ticks 1`. |
| `--tick-sec N` | `LOOP_TICK_SEC` | override sleep duration. |
| `--no-lock` | off | skip the loop.lock guard (test only — disables single-instance safety). |

## Status codes (emitted on exit)

| Code | Status | Meaning |
|---|---|---|
| `LOOP_DONE` | ok | completed `--max-ticks` ticks normally |
| `HALTED` | err | `halt-payments` present; operator must clear |
| `WAITING_RECOVERY` | err | registration codes hit (NOT_REGISTERED / WRONG_STATUS / NO_IDENTITY_CARD) — rerun the named recovery skill |
| `LOCK_BUSY` | err | another loop instance is running |
| `LOCK_CORRUPT` | err | `loop.lock` dir is partial / unreadable; operator inspection required |
| `RECOVERY_TOO_SOON` / `RECOVERY_PENDING` | retry | orphan INTENT under recovery; loop yields to next tick |
| `INTENT_AMBIGUOUS` / `INTENT_ABANDONED` | err | INTENT recovery quarantined; operator triages |
| `RECOVERY_RENAME_FAILED` | err | Step A matched a messageId but the rename to `pending-call-{messageId}.json` failed; operator must clear the partial state |
| `PENDING_INTENT` | err | unexpected status code from intent-recovery; defensive fallback |
| `SCRIPT_CONTRACT_VIOLATION` | err | a child script violated the JSON status protocol twice in one tick |
| `MISSING_STATE_DIR` / `MISSING_OWN_PID` / `MISSING_ACCOUNT` | err | required env not set |

## Single-instance guard

The loop acquires `$STATE_DIR/loop.lock` via `scripts/with-lock.sh` at startup (re-execs itself under the lock with a sentinel env var). A second instance gets `LOCK_BUSY` and exits. The lock wrapper has three branches in order — `flock` → `shlock` → `mkdir + stamp.json` — covering Linux, BSD/macOS, and last-resort fallback. SIGKILL recovery happens via the stamp's `pid + boot_id + start_time` check on the next startup.

## Durable artifacts

Full table in [`references/runtime-architecture.md`](references/runtime-architecture.md) §"Durable artifacts". Highlights:

- `state.json` — current state machine position (atomic .tmp+mv).
- `halt-payments` + `halt-reason.json` — operator-only halt flag (D5).
- `decisions/{inbox,active,done}/{ts|nonce}.json` — decision lifecycle.
- `pending-call-INTENT-{nonce}.json` — pre-send journal (closes the duplicate-spend window).
- `pending-call-{messageId}.json[.done]` — post-send journal.
- `pending-call-AMBIGUOUS-{nonce}.json` — INTENT recovery quarantine; **never retried**.
- `wallet-cli-out/{nonce}.log` — tee of vara-wallet stdout/stderr; recovery Step A reads this.
- `reconciliation.jsonl`, `budget-history.jsonl`, `loop-history.jsonl` — append-only audit logs.
- `wallet.lock`, `loop.lock` — concurrency guards.

## Running

```bash
# Operator one-time setup (registration, identity card) — see agent-onboarding.md.
# Then:
export VARA_AGENT_STATE_DIR="$HOME/.vara-agent/state"
export VARA_AGENT_OWN_PROGRAM_ID="0x..."
export VARA_WALLET_ACCOUNT="my-agent"
mkdir -p "$VARA_AGENT_STATE_DIR"

bash agent-starter/scripts/autonomous-loop.sh
```

For tests / smoke:

```bash
bash agent-starter/scripts/autonomous-loop.sh --once         # one tick, then exit
bash agent-starter/scripts/autonomous-loop.sh --max-ticks 5  # five ticks, then exit
```

## When to use

- **Always**, in autonomous mode. The PDF prescribes this. Operator-checklist mode is deprecated for the consumer side; operators flip the switch by running `scripts/autonomous-loop.sh` instead of executing the per-skill checklists by hand.
- For ad-hoc / partial workflows, run individual scripts directly (preflight, send, reconcile, budget-control). They each emit JSON status that the loop dispatches on, and they all share the same env contracts.

## Why these shapes

- **scripts/-as-runtime, .md-as-docs (B+ shape)** — Markdown skills can't be dispatched, can't be shellchecked, can't be unit-tested. Splitting runtime from documentation makes the loop testable and survives codex-grade review.
- **JSON status protocol with a parser** — Numeric exit codes can't carry symbolic names; `case "$?" in NOT_REGISTERED|...` is broken bash. Stdout JSON last-line + `lib/run-script.sh` parser gives unambiguous dispatch input. Malformed output, OOM-killed jq, signal-killed children, and stdout contamination all surface as `SCRIPT_CONTRACT_VIOLATION` rather than crashing the loop.
- **Pre-send INTENT journal + recovery scan** — The duplicate-spend window on hard crash mid-send is closed by the pre-send journal. Recovery scan prefers the wallet's own message id, falls back to indexer point query, and quarantines unresolvable INTENTs in `pending-call-AMBIGUOUS-{nonce}.json` rather than abandoning them. The loop never silently retries a call whose status it cannot prove.
- **Decision and INTENT lifecycle coupling** — Every `decisions/active/{nonce}.json` is paired with either a live wallet-lock holder, a pending INTENT, or a renamed `pending-call-{messageId}.json`. Recovery rules cover every gap so no `active/` orphan survives.
- **Tiered halt with operator-only clearance (D5)** — A single transient ESCALATE cannot halt the loop, but once a halt is real the operator owns clearance. Auto-clearance is dangerous given the seed-backend's 24h refill cooldown.
- **No auto-onboard (D8)** — `RegisterApplication`, `SubmitApplication`, `SetIdentityCard` are one-shot writes. Blind retry creates handle-squat risk. The loop emits one skill pointer and exits.
- **~75% consumer-only leaderboard cap** — Identity-card `howToInteract` contract closes the deregistration race that would otherwise trigger seed-backend's suspicious-spend monitor. The 25% outgoing slice via program-initiated calls is producer-side; deferred to next PR. Disclosed in [`references/season-economy.md`](references/season-economy.md).

## Cross-references

- Per-state skill docs: [`agent-rational-discovery.md`](agent-rational-discovery.md), [`agent-paid-integration.md`](agent-paid-integration.md), [`agent-payment-reconciliation.md`](agent-payment-reconciliation.md), [`agent-budget-control.md`](agent-budget-control.md), [`agent-mentions-listener.md`](agent-mentions-listener.md).
- Architecture deep dive: [`references/runtime-architecture.md`](references/runtime-architecture.md).
- Migration from operator-mode: [`references/migration-from-operator-mode.md`](references/migration-from-operator-mode.md).
- Build-time fee-model design (provider side): [`references/pricing.md`](references/pricing.md).
- Season constants and leaderboard weights: [`references/season-economy.md`](references/season-economy.md).
- Funding flow (PR #25): seed-backend service at `services/seed-backend/` (lands with PR #25; this branch references the design without a vendored link).
