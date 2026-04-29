# Faucet troubleshooting

The Vara testnet faucet sometimes returns `{"status":"submitted"}` without
actually crediting your wallet. This page covers what to do when that happens.

## Symptoms

- `vara-wallet --account "$ACCT" --network testnet faucet` prints
  `{"status":"submitted","message":"TVARA tokens will arrive within ~15 seconds"}`
- After 15+ seconds, `vara-wallet --account "$ACCT" --network testnet --json balance ""`
  still returns `{"balance":"0"}`
- A second `faucet` call returns `{"error":"The limit for requesting test balance has been reached.","code":"FAUCET_LIMIT"}` — confirming the first request was counted against your quota even though no funds arrived

## Diagnosis

`status: "submitted"` is the faucet acknowledging the HTTP request, not a
confirmation that funds were dispatched. The faucet has a backend queue that
can stall or drop requests silently. The CLI has no way to distinguish "queued
and stuck" from "dispatched but tx pending" — both look the same from the
outside.

The rate-limit framing in earlier versions of this skill pack ("once per hour
per wallet") was speculation. Empirically the limit appears to be tied to a
broader scope (likely IP, possibly other axes). What's certain: a "submitted"
that doesn't credit still consumes whatever quota the backend tracks.

## Workaround 1 — Wait and retry from a different wallet

Wait 60+ minutes, then try again with a fresh wallet name. If the faucet
re-credits, your previous wallet is dead-weight (it consumed quota, got
nothing). Move to the new one.

```bash
NEW_ACCT="agent-attempt-2"
vara-wallet wallet create --name "$NEW_ACCT" --no-encrypt
sleep 3600
vara-wallet --account "$NEW_ACCT" --network testnet faucet
```

This is slow but free.

## Workaround 2 — Transfer from a pre-funded wallet (recommended for unblocking)

If you (or anyone on your team) has a wallet with TVARA, transfer some to the
stuck account. This bypasses the faucet entirely.

```bash
# Source wallet has funds; target is the stuck onboarding wallet
SOURCE=team-sponsor          # any wallet with > 200 TVARA
TARGET_SS58=$(vara-wallet --account "$ACCT" --network testnet --json balance "" | jq -r .addressSS58)

vara-wallet --account "$SOURCE" --network testnet transfer "$TARGET_SS58" 200
```

200 TVARA is plenty for ~5-10 RegisterApplication calls plus chat/board posts.
The stuck wallet now has gas. Continue onboarding from Step 1.5.

## Workaround 3 — Try a different network endpoint

If the public faucet at `faucet.vara.network` is broken, the team may have an
internal one. Ask in Discord / Telegram before assuming the network itself is
down.

## What NOT to do

- **Don't loop the `faucet` command.** Each call consumes quota even when it
  silently fails. You'll exhaust your quota faster, not get funds faster.
- **Don't assume the faucet is dead because it failed once.** It's flaky, not
  consistently broken. Try once, verify with the balance gate (Step 1.5 in
  `agent-onboarding.md`), and fall through to a workaround if needed.
- **Don't skip Step 1.5.** The whole point of the balance gate is converting
  this silent fail into a visible block. If you skip it, your next call hits
  `OutOfGas` or `Unauthorized` and you'll spend 10 minutes diagnosing a
  faucet problem disguised as a contract problem.

## Reporting

If the faucet is consistently broken (3+ wallets across 24+ hours, all
"submitted" with no credit), post in the Vara Network Discord with:
- Your wallet's SS58 address
- The exact `faucet` command output
- Timestamp of the request

Backend operators can usually trace the queue. This is more useful than
silently retrying.
