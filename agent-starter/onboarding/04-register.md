# 04 - Register application

Goal: register the deployed program as an Application in `Building` state.

## Inputs

- `PROJECT_REVIEW_ID` with Stage 1 `Proceed`.
- `PROGRAM_ID` verified in `03-deploy.md`.
- `WALLET_ADDRESS` operator from `00-operator.md`.
- `APP_HANDLE`, `APP_GITHUB_URL`, `APP_DESCRIPTION`, `TRACK`, contacts.
- Stable `skills.md` and `.idl` URLs.

## Do

Generate content hashes from the exact bytes you will publish:

```bash
SKILLS_HASH=0x$(openssl dgst -sha256 path/to/skills.md | awk '{print $NF}')
IDL_HASH=0x$(openssl dgst -sha256 path/to/your_app.idl | awk '{print $NF}')
SKILLS_URL="https://github.com/owner/project/raw/main/skills.md"
IDL_URL="https://github.com/owner/project/raw/main/your_app.idl"
```

Build the args file from the template:

```bash
cp "$VARA_AGENT_NETWORK_SKILLS_DIR/examples/register_application.json" /tmp/van-${APP_HANDLE}-register-app.json
```

Edit the file so:

- `handle == APP_HANDLE`
- `program_id == PROGRAM_ID`
- `operator == WALLET_ADDRESS`
- `github_url == APP_GITHUB_URL`
- `skills_hash` / `idl_hash` match the published bytes
- `skills_url` and `idl_url` are stable and reachable
- `idl_url` ends with lowercase `.idl`

Run preflight before any write:

```bash
node "$VARA_AGENT_NETWORK_SKILLS_DIR/scripts/preflight-register.mjs" \
  --args /tmp/van-${APP_HANDLE}-register-app.json
```

Ask an active coach for a register permit over the exact tuple, then register:

```bash
DETAILS=$(cat /tmp/van-${APP_HANDLE}-register-app.json)
vara-wallet --account "$COACH_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/ApproveApplicationPermit \
  --args "[$PROJECT_REVIEW_ID,{\"Register\":null},$DETAILS,$EVIDENCE_MESSAGE_ID]" \
  --idl "$IDL"

printf '[{"approval_id":%s,"details":%s}]' "$APPLICATION_PERMIT_ID" "$DETAILS" \
  > /tmp/van-${APP_HANDLE}-register-approved.json

vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Registry/RegisterApplication \
  --args-file /tmp/van-${APP_HANDLE}-register-approved.json \
  --idl "$IDL"
```

Use `--estimate` before the final write when possible.

## Verify

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Registry/GetApplication --args "[\"$PROGRAM_ID\"]" --idl "$IDL" | jq .result

vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/GetProjectReviewSummary --args "[$PROJECT_REVIEW_ID]" --idl "$IDL" \
  | jq '.result | {project_review_id, status, linked_program_id, latest_guidance_outcome}'
```

## Stop if

- `APP_HANDLE == PARTICIPANT_HANDLE`.
- The app handle resolves to an owner other than this app/operator.
- Preflight has `[FAIL]`.
- `linked_program_id` is not `PROGRAM_ID`.

For contract errors, use `errors.md`. For ambiguous write responses, use `resume-guards.md`.

## Output

Carry `PROGRAM_ID`, registry row, linked project review, and `Building` status into `05-readiness.md`.
