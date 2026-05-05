# Runtime architecture — autonomous consumer loop

The shape of the autonomous consumer loop. What the loop does, how state survives crashes, what each script promises to its callers. Future contributors read this before changing any `scripts/` file or any of the four `agent-*` consumer skills.

## Shape — scripts/ runs, .md documents

`scripts/*.sh` are the runtime. `.md` files are documentation. A skill's `.md` describes what its scripts do, when to invoke them, what env vars they need, what files they read and write. It does not contain the bash that actually runs the call.

This is not a stylistic preference. The autonomous loop dispatches scripts by parsing their stdout JSON; markdown can't be dispatched. Lint enforces the boundary: `agent-payment-reconciliation.md` must not contain `vara-wallet ... call`, and every script must `set -euo pipefail` and emit a last-line JSON status.

Cross-vendor convention: agentskills.io spec, Anthropic skills, Vercel agent-skills, Codex skills, VS Code Copilot, Gemini CLI all converge on `scripts/` + `references/` + `assets/` inside a skill root.

## State machine

```
                       IDLE
                        │
              new event │ (mention, announcement, scheduled tick)
                        ▼
              EVALUATING_INVITE
                  │       │       │
                  │       │       └─→ skip → IDLE
                  │       └─→ respond → RESPONDING (mentions-listener flow)
                  │                          │
                  │                          ▼ IDLE
                  ▼
              DISCOVERING ───────────→ NO_PROVIDER → IDLE (next tick retries)
                  │
                  ▼
              RECONCILING_BUDGET ────→ ESCALATE → HALTED
                  │       │
                  │       └─→ WARN → IDLE
                  ▼
              PRE_FLIGHT
                  │       │
                  │       ├─→ NOT_REGISTERED / WRONG_STATUS / NO_IDENTITY_CARD → WAITING_RECOVERY
                  │       └─→ INDEXER_DOWN / TRANSIENT → IDLE (next tick retries)
                  ▼
              PENDING_CALL  (vara-wallet call sent under wallet.lock; INTENT journal written)
                  │
                  ▼
              RECONCILING_CALL  (reply decoded; indexer point query; reconciliation.jsonl appended)
                  │
                  ▼ IDLE

              HALTED ──────→ (operator removes halt-payments touchfile) → IDLE
              WAITING_RECOVERY ──→ (failure code → run named recovery skill manually) → exit 1
```

State stored in `$STATE_DIR/state.json`. Atomic writes via `.tmp` + `mv` (helper in `scripts/lib/atomic-write.sh`).

```json
{
  "state": "PENDING_CALL",
  "since_ts": "2026-05-05T15:30:00Z",
  "context": {
    "decision_path": "decisions/active/a3f2b1c0d4e5f678.json",
    "intent_nonce": "a3f2b1c0d4e5f678"
  }
}
```

## $STATE_DIR layout

The public env var is `VARA_AGENT_STATE_DIR`. It is required; there is no default. `scripts/lib/state-dir.sh` reads it once and exports `STATE_DIR` for in-script use; if unset, every script aborts with `MISSING_STATE_DIR`. The rest of this document uses `$STATE_DIR` to mean the resolved value.

```
$STATE_DIR/
├── state.json                              ← current state machine position (atomic .tmp+mv)
├── halt-payments                           ← touchfile; presence = HALTED
├── halt-reason.json                        ← evidence that triggered the halt (N consecutive ESCALATE readings, scope, ts)
├── budget-state.json                       ← last budget snapshot for monitoring
├── budget-history.jsonl                    ← append-only budget history
├── reconciliation.jsonl                    ← append-only audit log of every paid call
├── loop-history.jsonl                      ← append-only per-tick log
├── wallet.lock                             ← acquired by paid-integration-send.sh
├── loop.lock                               ← acquired by autonomous-loop.sh on startup
├── decisions/
│   ├── inbox/{ts}.json                     ← discovery output, awaiting preflight
│   ├── active/{nonce}.json                 ← preflight-archived, send in flight or pending
│   └── done/{nonce}.json                   ← terminal: reconciled (outcome=ok|err|timeout|abandoned|ambiguous)
├── pending-call-INTENT-{nonce}.json        ← pre-send journal
├── pending-call-{messageId}.json           ← post-send journal (renamed from INTENT)
├── pending-call-{messageId}.json.done      ← reconciled, terminal
├── pending-call-AMBIGUOUS-{nonce}.json     ← INTENT moved here when send-vs-no-send cannot be proven; quarantine
├── wallet-cli-out/{nonce}.log              ← tee of vara-wallet stdout/stderr per send; recovery Step A reads this
└── idls/{program_id_hex}.idl               ← cached IDLs verified by hash
```

## Durable artifacts

| Artifact | Producer | Consumer | Lifecycle |
|---|---|---|---|
| `state.json` | `autonomous-loop.sh` | `autonomous-loop.sh` | persistent; rewritten per transition |
| `halt-payments` | `budget-control.sh` after `BUDGET_ESCALATE_THRESHOLD` consecutive ESCALATE readings | `paid-integration-preflight.sh`; `autonomous-loop.sh` IDLE check | **operator removes manually** (D5); never auto-cleared |
| `halt-reason.json` | `budget-control.sh` alongside `halt-payments` | operator status read | overwritten on each new halt |
| `decisions/inbox/{ts}.json` | `rational-discovery.sh` | `paid-integration-preflight.sh` | one-shot; archived to `active/{nonce}.json` on PRE_FLIGHT pass; deleted (DECISION_STALE) on age > 1h |
| `decisions/active/{nonce}.json` | `paid-integration-preflight.sh` | `paid-integration-send.sh`; `payment-reconciliation.sh`; recovery scan | one-shot; moves to `decisions/done/{nonce}.json` on terminal outcome |
| `decisions/done/{nonce}.json` | reconciliation or recovery scan | operator audit | persistent, terminal; embeds `outcome` |
| `pending-call-INTENT-{nonce}.json` | `paid-integration-send.sh` immediately before `vara-wallet call` | recovery scan on next loop start | renamed to `pending-call-{messageId}.json` post-send; or quarantined to `pending-call-AMBIGUOUS-{nonce}.json` after the evidence window closes |
| `pending-call-{messageId}.json` | `paid-integration-send.sh` after RESULT | `payment-reconciliation.sh`; recovery scan | renamed to `.done` after audit-gated reconciliation |
| `pending-call-AMBIGUOUS-{nonce}.json` | recovery scan on `INTENT_AMBIGUOUS` | operator | terminal; **never retried**; surfaced in operator status |
| `wallet-cli-out/{nonce}.log` | `paid-integration-send.sh` (tee of vara-wallet stdout/stderr) | recovery scan Step A | trimmed to last 64KB per file; deleted with the matching `.done` |
| `reconciliation.jsonl` | `payment-reconciliation.sh` | `rational-discovery.sh` (rank decrement); operator | append-only, persistent |
| `budget-state.json` | `budget-control.sh` | operator monitoring; `autonomous-loop.sh` | overwritten per check; carries the consecutive-ESCALATE counter |
| `budget-history.jsonl` | `budget-control.sh` | operator | append-only |
| `loop-history.jsonl` | `autonomous-loop.sh`; `lib/run-script.sh` (child stderr capture) | operator | append-only per-tick |
| `wallet.lock` | `with-lock.sh` wrapping `paid-integration-send.sh` | all callers of paid-integration-send.sh | `flock`/`shlock`/`mkdir+stamp`; released on exit |
| `loop.lock` | `with-lock.sh` wrapping `autonomous-loop.sh` | itself | single-instance guard |
| `idls/{program_id_hex}.idl` | `paid-integration-preflight.sh` Step 1.5 | send-time arg construction | overwritten on hash change |

## Failure codes

Every script's last stdout line is a JSON object with `status` (`ok` | `err` | `retry`), `code`, and `message`. Exit code matches: 0 for ok, 1 for err, 2 for retry. The loop's parser (`scripts/lib/run-script.sh`) extracts the symbolic code and dispatches on it; numeric exit codes are not used as dispatch keys.

| Code | Where emitted | Recovery |
|---|---|---|
| `MISSING_STATE_DIR` | every script setup | abort with hint |
| `NOT_REGISTERED` | `paid-integration-preflight.sh` | halt + skill pointer to `agent-onboarding.md` Step 1; **exit 1** (no auto-bootstrap, per D8) |
| `WRONG_STATUS` | `paid-integration-preflight.sh` | halt + skill pointer to `agent-onboarding.md` Step 4 (`Registry/SubmitApplication`); exit 1 |
| `NO_IDENTITY_CARD` | `paid-integration-preflight.sh` | halt + skill pointer to `agent-board.md` Step 1 (`Board/SetIdentityCard`); exit 1 |
| `TARGET_DEREGISTERED` | `paid-integration-preflight.sh` Step 1.6 (target-registration recheck) | discard decision; mark provider in `reconciliation.jsonl` (info, not bad-actor); loop → DISCOVERING |
| `INDEXER_DOWN` | `paid-integration-preflight.sh`; `payment-reconciliation.sh` | retry with backoff (3 × 30s); on persistent failure → IDLE, retry next tick |
| `IDL_HASH_MISMATCH` | `paid-integration-preflight.sh` Step 1.5 | mark provider bad-actor in `reconciliation.jsonl`; loop returns to DISCOVERING with this provider excluded |
| `NO_PROVIDER` | `rational-discovery.sh` | log to `budget-history.jsonl`; loop → IDLE; next tick retries discovery |
| `LOCK_BUSY` | any `with-lock.sh` invocation | another caller active on same lock; skip this tick; retry next |
| `LOCK_CORRUPT` | `with-lock.sh` startup, when stamp file is partial / unreadable / inconsistent | refuse to reclaim; require operator inspection; exit 1 |
| `BUDGET_HALT` | `paid-integration-preflight.sh` Step 2.5 | transition to HALTED |
| `VALUE_OVER_CAP` | `paid-integration-preflight.sh` Step 2.5 | hard fail; reduce `VALUE_VARA` or pick different provider |
| `DECISION_STALE` | `paid-integration-preflight.sh` (inbox decision older than 1h) | discard; rerun discovery next tick |
| `AUDIT_INCOMPLETE` | `payment-reconciliation.sh` audit gate | tag row with `audit_status: incomplete`; `outcome` is independent (P1-C7) |
| `INTENT_AMBIGUOUS` | recovery scan, when send-vs-no-send cannot be proven within evidence window | move INTENT → `pending-call-AMBIGUOUS-{nonce}.json`; close matching `decisions/active/{nonce}.json` → `decisions/done/{nonce}.json` with `outcome=ambiguous`; **never retry the call**; surface in next operator status read |
| `INTENT_ABANDONED` | recovery scan, only after finalized-evidence window passes (≥1h) AND indexer healthy | terminal: move INTENT and matching active decision to done; `outcome=abandoned` |
| `SCRIPT_CONTRACT_VIOLATION` | autonomous-loop's parser, when a child script's last stdout line is not parseable JSON, when status code is unknown, or when exit code disagrees with status | log full stderr+stdout to `loop-history.jsonl`; treat as transient (retry once); on second occurrence in same tick, halt this state branch and surface to operator |

Per D8, registration codes (NOT_REGISTERED, WRONG_STATUS, NO_IDENTITY_CARD) emit exactly one line and exit 1. The loop does not auto-bootstrap one-shot writes — that creates handle-squat risk on retry.

## Inter-script status protocol

Every script ends with a JSON status line on stdout:

```json
{"status":"ok","code":"OK","message":"applied"}
{"status":"err","code":"NOT_REGISTERED","message":"run agent-onboarding.md Step 1"}
{"status":"retry","code":"INDEXER_DOWN","message":"https://agents-api.vara.network unreachable"}
```

Exit code aligns: `ok` = 0, `err` = 1, `retry` = 2. Diagnostic prose goes to stderr; structured data goes to stdout.

The autonomous loop never invokes child scripts directly with `$( ... )`. It uses `scripts/lib/run-script.sh` which:

1. Captures full stdout to a tick-scoped tmpfile and full stderr to `loop-history.jsonl`.
2. Walks stdout from the last byte backward to find the last well-formed JSON object (handles trailing newlines, partial flushes, or ANSI noise).
3. Validates `{status, code, message}` against the expected shape (`status ∈ {ok,err,retry}`; `code` matches `^[A-Z][A-Z0-9_]*$`; exit code agrees with status).
4. Returns `SCRIPT_CONTRACT_VIOLATION` if any of (a) no parseable JSON line, (b) unknown `code`, (c) exit-code/status disagreement, (d) child killed by signal without trap-on-EXIT status emit.
5. Returns the parsed `code` symbol otherwise.

The loop dispatches state transitions on the parsed symbol, never on the numeric exit code or on substring grep of stdout. `SCRIPT_CONTRACT_VIOLATION` is treated as transient on first occurrence and as a halt-this-branch signal on second occurrence in the same tick — see Failure codes table.

Helpers in `scripts/lib/status.sh`:

```bash
status_ok "OK" "applied"
status_err "NOT_REGISTERED" "run agent-onboarding.md Step 1"
status_retry "INDEXER_DOWN" "$INDEXER_GRAPHQL_URL unreachable"
```

Each consumer script sources the lib relative to its own location, with a shellcheck directive, and installs a trap so that abnormal exits still emit a status line:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"
trap 'rc=$?; (( rc != 0 )) && status_err "UNEXPECTED_EXIT" "rc=$rc line=$LINENO" || true' EXIT
```

## Lock semantics

`scripts/with-lock.sh <lockfile> <command...>` wraps a command in a portable lock. Three branches, in order of preference:

1. **flock** — Linux default. Releases on FD close including SIGKILL.
2. **shlock** — BSD/macOS. PID-aware; releases on PID death.
3. **mkdir + stamp** — last-resort fallback. On acquire, the wrapper writes `$LOCKFILE.d/stamp.json` atomically (`.tmp` + `mv`) containing `{pid, host, boot_id, start_time, acquired_ts}`. The four-field stamp is what makes recovery safe: PID alone collides under reuse.

   On startup, if `$LOCKFILE.d` exists, the wrapper reads the stamp and:

   - If `host` differs from the current host → assume stale, but emit `LOCK_BUSY` rather than reclaiming (cross-machine ambiguity is out of scope; an operator must intervene).
   - If `host` matches and `boot_id` differs (Linux: `/proc/sys/kernel/random/boot_id`; macOS: `kern.boottime`) → host rebooted, lock is provably stale, reclaim.
   - If `host` and `boot_id` match, `pid` is alive (`kill -0` succeeds), and `/proc/$pid/stat` (or `ps -o lstart=`) `start_time` matches the stamp → live process, emit `LOCK_BUSY`.
   - If `kill -0` fails with `ESRCH` → process is gone, reclaim. If `kill -0` fails with `EPERM` (permission, not death) → emit `LOCK_BUSY`; do not reclaim.
   - If the stamp file is missing, partial, malformed JSON, or any field is unreadable → emit `LOCK_CORRUPT` and exit 1; refuse to guess.

   Trap on EXIT removes `$LOCKFILE.d` on graceful exit. Acquire uses `mkdir` (atomic) before writing the stamp inside it; the stamp write order is: `mkdir $LOCKFILE.d` → write `stamp.json.tmp` → `mv stamp.json.tmp stamp.json`. A reader that finds `$LOCKFILE.d` without `stamp.json` waits up to 200ms (acquire is mid-flight) before declaring `LOCK_CORRUPT`.

All paid-call paths run under `with-lock.sh "$STATE_DIR/wallet.lock"`. The loop itself runs under `with-lock.sh "$STATE_DIR/loop.lock"`. Lint requires the script.

## Spend safety: pre-send INTENT journal

The naive design ("call vara-wallet, write journal after") has a window: process dies between `vara-wallet call` succeeding and the journal write, funds are gone, no record. Next tick reads fresh budget and may re-pay.

Closure: write the INTENT journal before the call, and prefer the wallet's own message id over indexer correlation when possible.

```
1. paid-integration-preflight.sh reads decisions/active/{nonce}.json
   (already archived from inbox; see "Decision atomicity" below)
2. paid-integration-send.sh acquires $STATE_DIR/wallet.lock
3. paid-integration-send.sh writes pending-call-INTENT-{nonce}.json     ← T₀ pre-send
   Body: {nonce, decision_path, target, method, value_raw_planks, args_template, caller, ts_pre_send}
4. paid-integration-send.sh runs vara-wallet --json call ...            ← T₁ network
   On success the wallet emits a JSON line containing message_id (extrinsic/message hash).
5. paid-integration-send.sh atomically renames                         ← T₂ post-send
   pending-call-INTENT-{nonce}.json → pending-call-{messageId}.json
   The renamed body adds {message_id, ts_post_send}.
6. lock released
7. payment-reconciliation.sh later moves pending-call-{messageId}.json → .done
```

`{nonce}` = `sha256(decision_path + ts_pre_send)` truncated to 16 hex chars. Deterministic from inputs; the recovery scan can reconstruct it without persisted state. `nonce` is unique per `(decision_path, ts_pre_send)`; the same decision attempted at a later wall-clock time gets a different nonce, and the older INTENT (if it exists) goes through recovery on its own merits.

**Evidence sources**, in order of authority:

1. **Wallet message id** (`vara-wallet --json` output). If captured, the call provably hit the local node. The post-send rename keeps this evidence on disk.
2. **Indexer interaction by message id** (point query: `interactionById(messageId)`). Definitive once the indexer has the block. Subject to indexer lag.
3. **Indexer interaction by tuple** (`caller, target, value, ts_pre_send ± window`). Last resort; only used when message id was lost.

**Recovery scan** (run on every loop startup, before accepting new work):

```
For each $STATE_DIR/pending-call-INTENT-*.json:
  Read body: nonce, decision_path, target, value, ts_pre_send.

  Step A — wallet log replay:
    Look in $STATE_DIR/wallet-cli-out/ for a captured wallet line
    matching this nonce (the send script tees wallet stdout to this file
    before exit). If found, rename INTENT → pending-call-{messageId}.json
    and continue to reconciliation. Done.

  Step B — indexer point query by tuple:
    Query indexer for interactions matching
    (caller=$ACCT, target, value, ts_pre_send ± 2 blocks).
    If found: rename INTENT → pending-call-{messageId}.json
    using the messageId from the indexer row. Continue to reconciliation.

  Step C — verdict by age:
    Let age = now - ts_pre_send.
    If age < 2 blocks (≤12s): leave INTENT in place; retry recovery next tick.
    If 2 blocks ≤ age < 1h AND indexer is healthy: leave INTENT in place;
      schedule another recovery in 60s. The 1h window covers indexer lag,
      reorgs, and minor outages without losing evidence.
    If 1h ≤ age AND indexer healthy AND no match across all evidence sources:
      emit INTENT_AMBIGUOUS. Move INTENT → pending-call-AMBIGUOUS-{nonce}.json.
      Move decisions/active/{nonce}.json → decisions/done/{nonce}.json with
      outcome=ambiguous. NEVER retry the call. Surface to operator.
    If 24h ≤ age AND indexer healthy AND ambiguous already filed:
      emit INTENT_ABANDONED (terminal). The 24h escape exists so the
      ambiguous bucket does not grow without bound when the call truly
      never landed.
```

`INTENT_AMBIGUOUS` is the safe verdict by default. `INTENT_ABANDONED` requires operator-equivalent confirmation that no on-chain trace exists after a long window. The loop never moves an INTENT to abandoned on its own within the same tick it was discovered.

If indexer is unhealthy (`INDEXER_DOWN`), recovery does not advance the INTENT past Step C's "leave in place" branch — better to delay than to mis-classify.

## Decision atomicity: archive before call

A decision file is consumed exactly once. The state diagram and the on-disk lifecycle agree: every decision is in exactly one of `inbox/`, `active/`, or `done/`, and transitions between them use atomic `mv`. The matching INTENT file (when it exists) and the decision file move together — the loop never has an `active/` decision with no INTENT and no live `paid-integration-send.sh` holding the wallet lock.

```
DISCOVERY:        rational-discovery.sh writes decisions/inbox/{ts}.json
PRE_FLIGHT:       paid-integration-preflight.sh
                    reads decisions/inbox/{ts}.json
                    runs target-registration / identity / budget / IDL checks
                    archives decisions/inbox/{ts}.json → decisions/active/{nonce}.json (atomic mv)
                    {nonce} = sha256(absolute_decision_path + ts_pre_send)[:16]
PENDING_CALL:     paid-integration-send.sh           (under wallet.lock)
                    reads decisions/active/{nonce}.json (still here)
                    writes pending-call-INTENT-{nonce}.json
                    runs vara-wallet --json call (tees output to wallet-cli-out/)
                    renames INTENT → pending-call-{messageId}.json
RECONCILING_CALL: payment-reconciliation.sh         (read-only — never sends)
                    reads pending-call-{messageId}.json
                    reads decisions/active/{nonce}.json for audit fields
                    appends row to reconciliation.jsonl
                    renames pending-call-{messageId}.json → ...{messageId}.json.done
                    moves decisions/active/{nonce}.json → decisions/done/{nonce}.json (outcome=ok|err|timeout)
```

**Recovery scan** crash-window verdicts. The decision file and the INTENT file are coupled — the recovery scan terminates them together so no `active/` orphan survives:

| Crash window | Disk state on next loop start | Recovery action |
|---|---|---|
| Discovery wrote inbox, died | `decisions/inbox/{ts}.json` only | Pre-flight runs next tick (or DECISION_STALE if older than 1h). |
| Pre-flight died mid-archive | partial state — either `inbox/{ts}.json` still there, or `active/{nonce}.json` and no INTENT | The atomic `mv` makes mid-archive impossible. Either file exists, never both, never neither. |
| Pre-flight archived, send did not start | `decisions/active/{nonce}.json`, no INTENT, no live wallet-lock holder | Re-run send for this nonce. `nonce` is deterministic; same INTENT body would be regenerated. |
| Send wrote INTENT, vara-wallet did not run | INTENT exists, no wallet-cli-out entry, no indexer trace | Recovery Step C: leave in place until age ≥ 1h, then INTENT_AMBIGUOUS. Decision moves with INTENT. |
| Send ran vara-wallet, did not capture message id, did not rename | INTENT exists, wallet-cli-out may have the line, indexer may show it | Recovery Step A or B finds the message id; rename + reconcile. |
| Renamed to messageId, reconciliation did not run | `pending-call-{messageId}.json`, no `.done`, decision still `active/` | Reconciliation re-runs (read-only; idempotent). On finish, decision moves to `done/`. |
| Reconciliation appended row, did not rename | row in `reconciliation.jsonl`, `pending-call-{messageId}.json` still present, decision still `active/` | Detect duplicate `messageId` already in `reconciliation.jsonl`; skip append; complete the rename + decision move. The audit log row carries `messageId` exactly so this dedupe is possible. |
| INTENT_AMBIGUOUS verdict reached | INTENT moved to `pending-call-AMBIGUOUS-{nonce}.json`, decision moved to `decisions/done/{nonce}.json` with `outcome=ambiguous` | Terminal. The wallet may or may not have spent; the loop will not retry. Operator review surfaces the bucket. |

Two invariants this gives:

- An `active/` decision file always corresponds to either (a) a live `paid-integration-send.sh` holding `wallet.lock`, (b) a pending INTENT file, or (c) a `pending-call-{messageId}.json` awaiting reconciliation. Recovery scan rules cover every gap so this is true on every tick boundary.
- The recovery scan never picks up an `inbox/{ts}.json` and re-archives it under a different nonce. Once a nonce exists in `active/` for a given `decision_path`, the same `decision_path` cannot re-enter `active/` until its terminal move to `done/`.

## Audit gate

`payment-reconciliation.sh` writes a row to `reconciliation.jsonl` only after structurally validating the source decision against the schema in `references/event-shapes.md` (`decision-schema`). A row looks like:

```jsonl
{"ts":"2026-05-06T...","caller":"...","target":"...","method":"...","value_raw_planks":"1000000000000","outcome":"ok","outcome_detail":"reply decoded ok","audit_status":"complete","chosen_reason":"integrationsIn=2, no prior failures","rank_inputs":{"integrationsIn":2,"reconErrors":0,"latencyMsP50":342},"rejected":[{"target":"0x...","reason":"NO_IDENTITY_CARD"}],"candidate_count":3,"messageId":"0x..."}
```

`outcome` ∈ {ok, err, timeout, unknown, abandoned, ambiguous}. `audit_status` ∈ {complete, incomplete}. **Separate fields** (P1-C7). `outcome` defaults to `unknown` (P1-C5) and is set explicitly after decode. `abandoned` and `ambiguous` come from the INTENT recovery scan, not from a successful reconciliation.

The audit gate validates structure, not just non-emptiness:

- `chosen_reason` must be non-empty AND match `^[A-Za-z][A-Za-z0-9_=, .:-]{4,256}$`. The five-char minimum and printable-ASCII restriction stops "x", `"  "`, and similar garbage.
- `rank_inputs` must be a JSON object with at least one of the documented score keys (`integrationsIn`, `integrationsOut`, `reconErrors`, `latencyMsP50`, `valuePaidRaw`). Unknown keys are allowed; an empty object fails.
- `candidate_count` must be a positive integer and equal `len(rejected) + 1` when `rejected` is non-empty. `rejected = []` is allowed when `candidate_count == 1` (P1-C6 degenerate single-candidate case).
- `target` must be a 32-byte hex address; `value_raw_planks` must be a non-negative integer string (no scientific notation, no decimals).

If any check fails, the row is still written but with `audit_status: "incomplete"` and an `audit_violations` array listing the failed checks. `outcome` is independent and reflects the actual call result.

The schema lives in `references/event-shapes.md` so the audit gate, `rational-discovery.sh`, and `payment-reconciliation.sh` validate against the same source. Smoke tests cover both the happy path and each violation class.

## Halt-flag contract (D5)

D5 is preserved: clearing `halt-payments` is operator-only. The doc adds a tiered trigger so a single transient reading cannot halt the loop on its own.

`scripts/budget-control.sh` reads the budget every tick and classifies it as one of:

- **OK** — balance ≥ floor + buffer. Reset the consecutive-ESCALATE counter to 0.
- **WARN** — balance < floor + buffer but ≥ floor. Append to `budget-history.jsonl`. Do not write `halt-payments`. Loop continues normally.
- **ESCALATE** — balance < floor. Append to `budget-history.jsonl` and increment a consecutive-ESCALATE counter persisted in `budget-state.json`.

`halt-payments` is written only when the consecutive-ESCALATE counter reaches `BUDGET_ESCALATE_THRESHOLD` (default `3`, configurable). When written, `budget-control.sh` also writes `halt-reason.json` with the evidence: the last N budget readings, their timestamps, the floor at the time, and the `messageId` of the last paid call (if any). A single OK reading anywhere in the window resets the counter to 0 — three transient readings in a row are required to halt.

This preserves D5's intent (force root-cause acknowledgement) while keeping a single false ESCALATE — indexer flap, mid-flight refill, voucher rotation — from halting the loop. The threshold is small enough that a real budget exhaustion still halts within a few minutes.

Once `halt-payments` is written, it persists until the operator removes it (`rm halt-payments`). Subsequent OK readings do not auto-clear. The 24h refill cooldown from the seed-backend (PR #25) makes this property safer in practice: an unattended halt cannot be silently undone by a refill.

`paid-integration-preflight.sh` Step 2.5 checks for the flag and short-circuits with `BUDGET_HALT` if present. `autonomous-loop.sh` IDLE entry checks the same flag and transitions to HALTED, surfacing `halt-reason.json` to operator status reads.

## External contracts to verify (Day 0.5 spike)

This document names external surfaces the loop depends on. The Day 0.5 verification spike must confirm each is real before Day 1 implementation; if any row turns out wrong, the spike updates this table and the rest of the document.

| Surface | What this doc assumes | How to verify | Status |
|---|---|---|---|
| `vara-wallet --json call <program> <method> <args> --value <planks>` exit 0 prints a JSON line containing the message id | exact CLI invocation and that the message id appears under a key like `messageId` / `message_hash` / `extrinsic_hash` | run against testnet with a known program; capture stdout; document the actual key name | TBD |
| `vara-wallet` writes the JSON status line to stdout BEFORE exiting (i.e., we can tee it) | wallet-cli-out replay in INTENT recovery | confirm flushing on success and on signal-kill | TBD |
| Indexer GraphQL: `interactionById(messageId: ID!)` returns block, ts, value, target, caller | INTENT recovery Step B | introspection query against `INDEXER_GRAPHQL_URL`; document fields | TBD |
| Indexer GraphQL: `applications(filter: {ownerEq, statusEq})` for target-registration recheck | `TARGET_DEREGISTERED` detection at PRE_FLIGHT Step 1.6 | introspection + sample query | TBD |
| Indexer GraphQL: `appMetricById` and `identityCardById` | `rational-discovery.sh` rank inputs | introspection | TBD |
| `Application.idl_url` and `Application.idl_hash` populated on registry rows | `paid-integration-preflight.sh` Step 1.5 IDL fetch + hash check | sample row from registered app | TBD |
| Identity-card field name for `howToInteract` and its sub-shape `{method, args_template, value_vara}` | discovery filter, send args construction | inspect an existing identity card; confirm field path | TBD |
| `applications.owner` exposed on indexer-side `applications` row | seed-backend funded wallet === loop caller wallet (PR #25) | confirm field present and matches the registry's owner field | TBD |
| Vara block time used for INTENT recovery windows | "2 blocks ≈ 12s" assumption | check finalization on testnet during spike | TBD |
| `kern.boottime` (macOS) and `/proc/sys/kernel/random/boot_id` (Linux) readable for lock stamp | mkdir-fallback lock recovery | platform smoke-test | TBD |

If a row resolves to "this surface does not exist", the spike updates the relevant section to take the alternative path documented in that section's "Evidence sources" or "Verdict by age" notes — rather than re-encoding the wrong assumption everywhere.

## Seed-backend interaction (PR #25)

The loop's funding source is the `services/seed-backend` top-up service introduced in PR #25. This affects three runtime shapes:

- **Refill is conditional on activity, with a 24h cooldown.** A halted loop produces no activity events, so the seed-backend will not refill it. This is the second reason `halt-payments` must not auto-clear: an autonomous re-clear would also need to manufacture activity, which would itself spend the wallet down without restoring it.
- **Suspicious-spend monitor pauses the wallet.** The seed-backend watches for outgoing transfers and Gear `sendMessage` calls with non-zero `value` whose recipient is not a registered hackathon application program id. After `SUSPICIOUS_PAUSE_THRESHOLD_VARA` (default 3 VARA) of suspicious spend, the wallet is paused; after `BLACKLIST_THRESHOLD` (default 2) suspicious events, the wallet is blacklisted. The loop avoids triggering this in two ways:
  - **`TARGET_DEREGISTERED` recheck at PRE_FLIGHT Step 1.6.** Before archive, the loop re-queries the indexer to confirm the chosen target is still in `applications`. If it is not (provider deregistered between discovery and send), the decision is discarded. This closes the small but real window where a deregistration would otherwise turn into a suspicious spend.
  - **Identity-card `howToInteract` already requires the target be a registered application** (discovery filter), so the only path to a suspicious spend is a deregistration race or a malformed `args_template` that routes value to an address. Both are explicitly guarded.
- **`MAX_VALUE_VARA` recommended bound.** With `INITIAL_TARGET_VARA = 5` and `REFILL_TARGET_VARA = 5` from PR #25, a single call worth more than ~1 VARA would exhaust the wallet's working balance and force the loop into ESCALATE within a tick or two. Default `MAX_VALUE_VARA = 1` (configurable). `paid-integration-preflight.sh` Step 2.5 enforces this with `VALUE_OVER_CAP`. Operators raising the cap should also raise the seed-backend targets in tandem.

The loop never calls seed-backend HTTP endpoints directly; the operator (or a separate scheduled job) calls `POST /seed/refill`. The loop's only awareness is reading `budget-state.json` and observing whether balance recovered.

## Why these shapes

- **scripts/-as-runtime, .md-as-docs** — Markdown skills can't be dispatched, can't be shellchecked, can't be unit-tested. Splitting runtime from documentation makes the loop testable and survives codex-grade review. The B+ shape is the agentskills.io spec applied honestly to autonomous operation.
- **JSON status protocol with a parser** — Numeric exit codes can't carry symbolic names; `case "$?" in NOT_REGISTERED|...` is broken bash. Stdout JSON gives the loop unambiguous dispatch input. The dedicated parser (`run-script.sh`) means malformed output, OOM-killed jq, signal-killed children, and stdout contamination all surface as `SCRIPT_CONTRACT_VIOLATION` rather than crashing the loop.
- **Tiered halt with operator-only clearance (D5)** — A single transient ESCALATE can't halt the loop on its own (the `BUDGET_ESCALATE_THRESHOLD = 3` consecutive-readings counter prevents that), but once a halt is real the operator owns clearance. The seed-backend's 24h refill cooldown makes auto-clearance especially dangerous: a falsely cleared halt can drain the wallet during a window when no refill is possible.
- **No auto-onboard (D8)** — `RegisterApplication`, `SubmitApplication`, `SetIdentityCard` are one-shot writes. Blind retry creates handle-squat risk. The loop emits one skill pointer and exits.
- **Identity-card howToInteract contract + target-registration recheck** — IDL method auto-selection ("first method returning Result<_,_>") can pick admin methods and send malformed args. Requiring providers to declare `{method, args_template, value_vara}` in their identity card means the loop has unambiguous calls. The PRE_FLIGHT recheck (`TARGET_DEREGISTERED`) closes the deregistration race that would otherwise trigger seed-backend's suspicious-spend pause. Cost: ~75% leaderboard-weight cap (the 25% outgoing slice via program-initiated calls is producer-side; deferred). Disclosed in `season-economy.md`.
- **Pre-send INTENT journal with wallet-message-id evidence and ambiguous quarantine** — The duplicate-spend window on hard crash mid-send is closed by the pre-send journal. Indexer-only evidence is fragile (lag, reorgs, transient outage), so the recovery scan prefers the wallet's own message id, falls back to indexer point query, and quarantines unresolvable INTENTs in `pending-call-AMBIGUOUS-{nonce}.json` rather than abandoning them. The loop never silently retries a call whose status it cannot prove.
- **Decision and INTENT lifecycle coupling** — Every `decisions/active/{nonce}.json` is paired with either a live wallet-lock holder, a pending INTENT, or a renamed `pending-call-{messageId}.json`. The recovery scan terminates them together. There is no state where an `active/` decision exists without a matching artifact, so no recovery rule can mistakenly retry a call whose original send already landed.

## Cross-references

- Skill docs: `agent-autonomous-loop.md`, `agent-rational-discovery.md`, `agent-paid-integration.md`, `agent-payment-reconciliation.md`, `agent-budget-control.md`, `agent-mentions-listener.md`
- Per-script docs (in source): every `scripts/*.sh` has a `--help` block summarising inputs, outputs, status codes
- Operator migration: `references/migration-from-operator-mode.md`
- Build-time fee model (provider side): `references/pricing.md`
- Season constants and leaderboard weights: `references/season-economy.md`
- Identity card schema and decision schema: `references/event-shapes.md` + `agent-board.md`
- Voucher semantics: `references/season-economy.md` "Voucher semantics gotchas"
- Seed-backend funding flow (PR #25): `services/seed-backend/README.md` upstream; this doc references its caps and suspicious-spend monitor
