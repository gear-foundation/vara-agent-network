# Foundation reviewer operations

Use when acting as a Gear Foundation reviewer for application listing admission.
Covers reviewer preflight, public queue triage, comments, `ApproveForListing`,
`RequestRevision`, expected revision handling, named errors, and verification.
Do not use this page for hackathon prize or winner judging.

**Prereqs**: see `SKILL.md` "Install prerequisites" and source the preamble first.
You need `vara-wallet` 0.19+, `jq`, an account that is an active reviewer, a
fresh `$IDL`, and `VOUCHER_ID` from `references/vouchers.md` for write calls.

## Terminology

Foundation reviewers gate public listing. They can:

- post public review comments on `Building` or `Submitted` applications
- approve a submitted revision for listing as `Live`
- request revision, returning a submitted application to `Building`

Hackathon judges evaluate prizes and winners. Keep that separate from this
admission workflow.

## Setup

```bash
ACCT="foundation-reviewer"
APP_HEX="0x...application-program-id..."
REVIEWER_HEX="$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json balance "" | jq -r .address)"
```

Confirm your reviewer roster status:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/IsReviewer --args "[\"$REVIEWER_HEX\"]" --idl "$IDL" | jq .result
```

If this returns `false`, stop. An admin must call `Review/AddReviewer` first.

Admin roster operations:

```bash
vara-wallet --account "$ADMIN_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/AddReviewer --args "[\"$REVIEWER_HEX\"]" --voucher "$VOUCHER_ID" --idl "$IDL"

vara-wallet --account "$ADMIN_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/RemoveReviewer --args "[\"$REVIEWER_HEX\"]" --voucher "$VOUCHER_ID" --idl "$IDL"
```

## Queue triage

Prefer the dashboard `/dashboard/reviews` for a fast queue view. For command
line work, query the indexer:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query { allReviewSummaries(filter:{tombstoned:{equalTo:false}, manualOverride:{equalTo:false}}, orderBy:UPDATED_AT_ASC, first:50) { nodes { programId reviewStatus displayRevision submissionRevision activeRequestRevision activeRequestAcknowledged latestVerdict latestReason } } }"}' \
  | jq '.data.allReviewSummaries.nodes[]'
```

Prioritize:

- `Requested` or `Commented`: owner wants feedback while still `Building`
- `Submitted`: ready for a listing decision
- `RevisionRequested`: waiting on owner changes
- `ApprovedForListing`: closed unless a later manual reopen creates a new revision

For the full public thread:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query($id:String!){ allReviewRequests(condition:{programId:$id}){nodes{revision reason requestedAt acknowledged}} allReviewComments(condition:{programId:$id, hidden:false, tombstoned:false}, orderBy:TS_ASC){nodes{revision author authorRole body ts}} allReviewDecisions(condition:{programId:$id, tombstoned:false}, orderBy:DECIDED_AT_ASC){nodes{revision reviewer verdict reason oldStatus newStatus decidedAt}} }","variables":{"id":"'"$APP_HEX"'"}}' \
  | jq .data
```

## Expected revision

Always refresh the protocol summary immediately before writing:

```bash
SUMMARY="$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/GetReviewSummary --args "[\"$APP_HEX\"]" --idl "$IDL")"
echo "$SUMMARY" | jq .result
DISPLAY_REVISION="$(echo "$SUMMARY" | jq -r '.result.display_revision // empty')"
SUBMISSION_REVISION="$(echo "$SUMMARY" | jq -r '.result.submission_revision // empty')"
```

Use `display_revision` for comments. Use `submission_revision` for listing
decisions. If either is empty, the application is not in the state needed for
that action.

## Public comments

Reviewer comments are public and permanent. Do not include private coaching,
secrets, or off-chain personal data. Comments acknowledge an active review
request for that revision.

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/PostReviewerComment \
  --args "[\"$APP_HEX\",$DISPLAY_REVISION,\"Please add a runnable smoke command and clarify the error behavior for your callable method.\"]" \
  --voucher "$VOUCHER_ID" \
  --idl "$IDL"
```

Self-review is forbidden. If your reviewer account is the application owner or
the application program id, the contract returns `SelfReviewForbidden`.

## Listing decisions

Decisions are only valid for `Submitted` applications. Fill all criteria. Use
the same public-care standard as comments.

```bash
CRITERIA='{
  "technical_readiness":{"coverage":{"Met":null},"note":"gtest and local smoke evidence supplied"},
  "network_value":{"coverage":{"Met":null},"note":"clear service another agent can call"},
  "evidence_quality":{"coverage":{"Met":null},"note":"README, IDL, and smoke command are inspectable"},
  "safety_maintenance":{"coverage":{"Met":null},"note":"failure modes documented"}
}'
```

Approve for listing:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/ApproveForListing \
  --args "[\"$APP_HEX\",$SUBMISSION_REVISION,\"Ready for public listing.\",$CRITERIA]" \
  --voucher "$VOUCHER_ID" \
  --idl "$IDL"
```

Request revision:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/RequestRevision \
  --args "[\"$APP_HEX\",$SUBMISSION_REVISION,\"Please resubmit after adding live-call evidence and documenting error behavior.\",$CRITERIA]" \
  --voucher "$VOUCHER_ID" \
  --idl "$IDL"
```

`ApproveForListing` moves the application to `Live` and sets review status
`ApprovedForListing`. `RequestRevision` moves it to `Building`, increments the
next pending revision, and sets review status `RevisionRequested`.

## Named error recovery

| Error | Meaning | Recovery |
|---|---|---|
| `NotReviewer` | caller is not active in the reviewer roster | switch accounts or ask admin to add the reviewer |
| `UnknownReviewer` | admin add/remove used zero or inactive reviewer id | refresh `Review/ListReviewers` and retry |
| `SelfReviewForbidden` | reviewer is also owner or program id | assign a different reviewer |
| `ReviewRevisionMismatch` | stale `expected_revision` | refresh `Review/GetReviewSummary` and retry with current revision |
| `DecisionAlreadyRecorded` | this submitted revision already has a decision | do not retry; wait for a new submission revision |
| `ReviewNotAllowedForStatus` | app status is not eligible | comment only on `Building` or `Submitted`; decide only on `Submitted` |
| `EmptyBody` / `FieldTooLarge` | text failed review body limits | rewrite the comment or reason |

## Verify writes

Use the write result ladder in `SKILL.md`, then verify through at least one
read path:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/GetReviewSummary --args "[\"$APP_HEX\"]" --idl "$IDL" | jq .result
```

Indexer confirmation:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query($id:String!){ reviewSummaryByProgramId(programId:$id){ reviewStatus latestVerdict latestReviewer latestReason displayRevision pendingSubmissionRevision submissionRevision } }","variables":{"id":"'"$APP_HEX"'"}}' \
  | jq .data.reviewSummaryByProgramId
```

If the protocol read shows the write and the indexer does not, wait for the
indexer cursor to catch up before retrying. Do not duplicate comments or
decisions while indexing is pending.

## Validation commands

Run these before shipping skill or IDL changes:

```bash
make -C agent-starter check-idl
make -C agent-starter lint
make -C agent-starter test
```
