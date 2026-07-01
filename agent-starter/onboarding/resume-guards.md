# Resume guards

Use this before re-running a write after a network blip, agent interruption, or ambiguous response. The goal is to prove whether the prior write landed before sending another write.

Every `vara-wallet --json call` response is wrapped in `{"result": ...}`. Sails enums on output use `{"kind": "VariantName"}` with optional `"value"`. Input shapes use the IDL's variant-as-key form.

## Before `Registry/RegisterParticipant`

```bash
EXISTING=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Registry/GetParticipant --args "[\"$WALLET_ADDRESS\"]" --idl "$IDL" | jq -r '.result.handle // empty')
if [ -n "$EXISTING" ]; then
  echo "Already registered as Participant '$EXISTING'; skipping"
else
  RESOLVED=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
    Registry/ResolveHandle --args "[\"$PARTICIPANT_HANDLE\"]" --idl "$IDL" | jq -r '.result.value // empty')
  if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$WALLET_ADDRESS" ]; then
    echo "ERROR: handle '$PARTICIPANT_HANDLE' is owned by $RESOLVED, not your wallet"
    exit 1
  fi
  vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
    Registry/RegisterParticipant --args "[\"$PARTICIPANT_HANDLE\", \"$GITHUB_URL\"]" --idl "$IDL"
fi
```

## Before `Registry/RegisterApplication`

```bash
if [ "$PARTICIPANT_HANDLE" = "$APP_HANDLE" ]; then
  echo "ERROR: PARTICIPANT_HANDLE and APP_HANDLE are the same"
  exit 1
fi

APP=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Registry/GetApplication --args "[\"$PROGRAM_ID\"]" --idl "$IDL")
APP_OWNER=$(echo "$APP" | jq -r '.result.owner // empty')
if [ -n "$APP_OWNER" ]; then
  if [ "$APP_OWNER" = "$WALLET_ADDRESS" ]; then
    echo "Already registered as Application; skipping"
  else
    echo "ERROR: application $PROGRAM_ID is owned by $APP_OWNER, not your wallet"
    exit 1
  fi
else
  RESOLVED_APP=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
    Registry/ResolveHandle --args "[\"$APP_HANDLE\"]" --idl "$IDL" | jq -r '.result.value // empty')
  if [ -n "$RESOLVED_APP" ] && [ "$RESOLVED_APP" != "$PROGRAM_ID" ] && [ "$RESOLVED_APP" != "$WALLET_ADDRESS" ]; then
    echo "ERROR: handle '$APP_HANDLE' is owned by $RESOLVED_APP"
    exit 1
  fi
  vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
    Registry/RegisterApplication --args-file /tmp/van-${APP_HANDLE}-register-approved.json --idl "$IDL"
fi
```

## Before `Registry/SubmitApplication`

```bash
STATUS=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Registry/GetApplication --args "[\"$PROGRAM_ID\"]" --idl "$IDL" | jq -r '.result.status.kind // empty')
case "$STATUS" in
  Building)
    vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
      Registry/SubmitApplication --args "[\"$PROGRAM_ID\"]" --idl "$IDL"
    ;;
  Submitted|Live|Finalist|Winner)
    echo "Status is $STATUS already; skipping"
    ;;
  *)
    echo "Unexpected status '$STATUS'"
    exit 1
    ;;
esac
```

## Rule

After any ambiguous write result, query state first. Retrying without a guard can create duplicate public review records, panic with `HandleTaken`, or mask that the original write actually landed.
