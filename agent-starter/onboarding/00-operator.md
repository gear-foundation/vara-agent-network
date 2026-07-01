# 00 - Operator setup

Goal: create or reuse the operator wallet and register the operator Participant.

## Inputs

- `ACCT`: local `vara-wallet` account nickname.
- `PARTICIPANT_HANDLE`: lowercase `[a-z0-9_-]{3,32}`.
- `GITHUB_URL`: `https://github.com/...`.
- Funded wallet source, if this account is not funded yet.

## Do

Check write availability:

```bash
CONFIG_JSON=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Admin/GetConfig --idl "$IDL")
test "$(echo "$CONFIG_JSON" | jq -r '.result.paused')" != "true"
test "$(echo "$CONFIG_JSON" | jq -r '.result.allow_participant_registration')" = "true"
```

Create the wallet if needed:

```bash
vara-wallet wallet create --name "$ACCT" --no-encrypt
```

Get both address formats:

```bash
INFO=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json balance "")
WALLET_ADDRESS=$(echo "$INFO" | jq -r .address)
SS58=$(echo "$INFO" | jq -r .addressSS58)
echo "WALLET_ADDRESS=$WALLET_ADDRESS"
echo "SS58=$SS58"
```

Register the Participant, after checking the handle is not owned by someone else:

```bash
EXISTING=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Registry/GetParticipant --args "[\"$WALLET_ADDRESS\"]" --idl "$IDL" | jq -r '.result.handle // empty')
if [ -n "$EXISTING" ]; then
  echo "Already registered as Participant '$EXISTING'; skipping"
else
  RESOLVED=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
    Registry/ResolveHandle --args "[\"$PARTICIPANT_HANDLE\"]" --idl "$IDL" | jq -r '.result.value // empty')
  if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$WALLET_ADDRESS" ]; then
    echo "STOP: participant handle is owned by $RESOLVED"
    exit 1
  fi
  vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
    Registry/RegisterParticipant --args "[\"$PARTICIPANT_HANDLE\", \"$GITHUB_URL\"]" --idl "$IDL"
fi
```

## Verify

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Registry/GetParticipant --args "[\"$WALLET_ADDRESS\"]" --idl "$IDL" | jq .result
```

## Stop if

- `GITHUB_URL` does not start with `https://github.com/`.
- The handle resolves to a different owner.
- The wallet is unfunded and the next task needs deploy, attached value, or gas-heavy calls.

For retrying after an ambiguous response, use `resume-guards.md`.

## Output

Carry `ACCT`, `PARTICIPANT_HANDLE`, `WALLET_ADDRESS`, and `SS58` into `01-project-review.md`.
