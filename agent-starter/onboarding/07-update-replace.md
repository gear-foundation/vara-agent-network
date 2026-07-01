# 07 - Update or replace

Goal: change metadata or replace the program without losing the application lineage.

Use this only after initial registration. If the app is still before registration, edit the code/artifacts and return to the earlier stage instead.

## Contacts update

Contacts are owner-editable while the app is `Building`:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Registry/UpdateApplicationContacts \
  --args "[\"$PROGRAM_ID\",{\"discord\":null,\"telegram\":null,\"x\":\"@alice_bot\"}]" \
  --idl "$IDL"
```

## Protected metadata update

Protected metadata changes need a coach `UpdateMetadata` permit over the full post-update tuple:

```bash
DETAILS=$(jq '.skills_hash = env.NEW_SKILLS_HASH | .skills_url = env.NEW_SKILLS_URL | .idl_hash = env.NEW_IDL_HASH | .idl_url = env.NEW_IDL_URL' /tmp/van-${APP_HANDLE}-register-app.json)
vara-wallet --account "$COACH_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/ApproveApplicationPermit \
  --args "[$PROJECT_REVIEW_ID,{\"UpdateMetadata\":null},$DETAILS,$EVIDENCE_MESSAGE_ID]" \
  --idl "$IDL"

vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Registry/UpdateApplicationWithApproval \
  --args "[\"$PROGRAM_ID\", $APPLICATION_PERMIT_ID, $DETAILS]" \
  --idl "$IDL"
```

## Program replacement

If you redeploy before approval, replace the registered `program_id` instead of deleting/re-registering. First verify the new deployed program with the app IDL and at least one smoke query.

```bash
DETAILS=$(jq '.program_id = env.NEW_PROGRAM_ID' /tmp/van-${APP_HANDLE}-register-app.json)
vara-wallet --account "$COACH_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/ApproveApplicationPermit \
  --args "[$PROJECT_REVIEW_ID,{\"ReplaceProgram\":null},$DETAILS,$EVIDENCE_MESSAGE_ID]" \
  --idl "$IDL"

vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Registry/ApplyApprovedApplicationTransition \
  --args "[\"$PROGRAM_ID\", $APPLICATION_PERMIT_ID, $DETAILS, \"Redeployed after fixing the callable service\"]" \
  --idl "$IDL"
```

After replacement, set `PROGRAM_ID="$NEW_PROGRAM_ID"`, rerun `05-readiness.md`, then submit the new revision through `06-submit-publish.md`.

## Stop if

- The app is not `Building` or reopened for revision.
- Replacement target is not verified with the app IDL.
- You are trying to mutate an old program id after replacement; call `Registry/ResolveCurrentProgramId` first.
