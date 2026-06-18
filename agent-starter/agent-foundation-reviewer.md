# Foundation reviewer operations

Use when acting as a Gear Foundation reviewer for application listing admission.
Covers reviewer preflight, public queue triage, comments, `PublishApplication`,
`RequestPublishChanges`, expected revision handling, named errors, and verification.
Do not use this page for hackathon prize or winner judging.

**Prereqs**: see `SKILL.md` "Install prerequisites" and source the preamble first.
You need `vara-wallet` 0.19+, `jq`, an account that is an active reviewer, a
fresh `$IDL`, `allow_review=true` from `Admin/GetConfig`, and
`VAN_WRITE_GAS_ARGS` from `references/vouchers.md` for write calls.
If you jump straight to this page, run the `SKILL.md` preamble first. After
`OPERATOR_HEX` is known, run `references/vouchers.md`; otherwise write examples
using `"${VAN_WRITE_GAS_ARGS[@]}"` have no gas-args array in scope.

## Terminology

Foundation reviewers gate public publish. They can:

- guide pre-deploy projects before any application is registered
- post public review comments on `Building` or `Submitted` applications
- publish a submitted revision as `Live`
- request publish changes, returning a submitted application to `Building`

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
  Review/AddReviewer --args "[\"$REVIEWER_HEX\"]" "${VAN_WRITE_GAS_ARGS[@]}" --idl "$IDL"

vara-wallet --account "$ADMIN_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/RemoveReviewer --args "[\"$REVIEWER_HEX\"]" "${VAN_WRITE_GAS_ARGS[@]}" --idl "$IDL"
```

## How project reviews start and link

Builders submit pre-deploy project reviews before an application program exists.
`Review/SubmitProjectReview` takes `SubmitProjectReviewReq { github_url, idea }`
and returns the durable `u64` project review id. These are builder/owner
handoff commands; do not run them with the reviewer `ACCT`.

```bash
BUILDER_ACCT="builder-owner"
APP_GITHUB_URL="https://github.com/owner/project"
APP_DESCRIPTION="One-line product idea"

PROJECT_REVIEW_REQ=$(jq -nc \
  --arg github "$APP_GITHUB_URL" \
  --arg idea "$APP_DESCRIPTION" \
  '{github_url:$github, idea:$idea}')

SUBMIT_IDEA_JSON=$(vara-wallet --account "$BUILDER_ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/SubmitProjectReview \
  --args "[$PROJECT_REVIEW_REQ]" \
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL")
PROJECT_REVIEW_ID=$(echo "$SUBMIT_IDEA_JSON" | jq -r '.result // empty')
echo "PROJECT_REVIEW_ID=$PROJECT_REVIEW_ID"
```

After the builder deploys and registers the application, the same owner account
links that review to the application with `Review/LinkProjectReviewToApplication`.
This is owner-side, not reviewer-side; reviewers should verify the link or ask
the builder to run it after latest guidance is `Proceed`.

```bash
vara-wallet --account "$BUILDER_ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/LinkProjectReviewToApplication \
  --args "[$PROJECT_REVIEW_ID,\"$APP_HEX\"]" \
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL"
```

## Pre-deploy project queue

Prefer the dashboard `/dashboard/project-reviews`. For command line work, query the
indexer-backed queue. Prioritize submitted/commented projects with no guidance,
then projects where the owner replied with new evidence:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query { allProjectReviewSummaries(condition:{hidden:false,tombstoned:false}, orderBy:UPDATED_AT_DESC, first:50) { nodes { projectReviewId owner githubUrl idea status linkedProgramId commentCount latestGuidanceOutcome updatedAt } } }"}' \
  | jq '.data.allProjectReviewSummaries.nodes[]'
```

If the indexer is behind, use the on-chain fallback:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/ListProjectReviewSummaries --args "[null,50]" --idl "$IDL" \
  | jq '.result.items[]'
```

For the next page, pass the prior response's `.result.next_cursor` in place of
`null`.

For the full public thread:

```bash
PROJECT_REVIEW_ID=1

curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg id "$PROJECT_REVIEW_ID" \
    '{query:"query($id:String!){ allProjectReviewSummaries(first:1,condition:{projectReviewId:$id,hidden:false,tombstoned:false}){nodes{projectReviewId owner githubUrl idea status linkedProgramId latestGuidanceOutcome latestGuidance latestReviewer updatedAt}} allProjectReviewComments(condition:{projectReviewId:$id,hidden:false,tombstoned:false},orderBy:TS_ASC,first:250){nodes{author authorRole body ts}} allProjectReviewGuidances(condition:{projectReviewId:$id,hidden:false,tombstoned:false},orderBy:TS_ASC,first:100){nodes{reviewer outcome body ts}} allProjectReviewLinks(condition:{projectReviewId:$id},orderBy:LINKED_AT_ASC,first:20){nodes{programId linkedAt}} }",variables:{id:$id}}')" \
  | jq .data
```

Reviewer comments and guidance are public and permanent. Do not include private
coaching notes, secrets, or off-chain personal data.

Use `Review/PostProjectReviewerComment` for questions or short notes that do not
change the recommendation:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/PostProjectReviewerComment \
  --args "[$PROJECT_REVIEW_ID,\"The project is strongest if it names a real consuming app and a callable method.\"]" \
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL"
```

Use `Review/RecordProjectGuidance` for the stateful reviewer outcome that builders
should act on before deployment:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/RecordProjectGuidance \
  --args "[$PROJECT_REVIEW_ID,{\"Proceed\":null},\"Proceed if the builder proves demand with one integration partner.\"]" \
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL"
```

Guidance rubric:

| Outcome | Use when | Useful reviewer note |
|---|---|---|
| `Proceed` | The project is worth building now. | Name the expected proof: target caller, callable method, repo artifact, or integration evidence. |
| `NeedsChanges` | The value is plausible but the scope, consumer, integration, first method, or evidence is unclear. | Tell the builder exactly what to narrow or prove before deploying. |
| `NotRecommended` | The project is unlikely to create network value in its current form. | Explain the reason and suggest a pivot if one is obvious. |

Self-review is forbidden for project reviews too. If your reviewer account owns the
project, use a different reviewer.

Verify project-review writes with the protocol read first:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/GetProjectReviewSummary --args "[$PROJECT_REVIEW_ID]" --idl "$IDL" | jq .result
```

Then confirm the indexer caught up:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg id "$PROJECT_REVIEW_ID" \
    '{query:"query($id:String!){ allProjectReviewSummaries(first:1,condition:{projectReviewId:$id}){nodes{projectReviewId status latestGuidanceOutcome latestGuidance latestReviewer linkedProgramId updatedAt}} }",variables:{id:$id}}')" \
  | jq '.data.allProjectReviewSummaries.nodes[0]'
```

If the protocol read shows the comment/guidance and the indexer does not, wait
for the indexer cursor to catch up. Do not duplicate comments or guidance while
indexing is pending.

## Queue triage

Prefer the dashboard `/dashboard/reviews` for a fast queue view. For command
line work, query the indexer:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query { allReviewSummaries(filter:{tombstoned:{equalTo:false}}, orderBy:UPDATED_AT_ASC, first:50) { nodes { programId reviewStatus manualOverride displayRevision submissionRevision activeRequestRevision activeRequestAcknowledged latestVerdict latestReason } } }"}' \
  | jq '.data.allReviewSummaries.nodes[]'
```

Prioritize:

- `Requested` or `Commented`: owner wants feedback while still `Building`
- `Submitted`: ready for a listing decision
- `RevisionRequested`: waiting on owner changes
- `ManualOverride` with a new display/pending revision: admin reopened the app; treat it as the next review round and refresh the protocol summary before commenting
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
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL"
```

Self-review is forbidden. If your reviewer account is the application owner or
the application program id, the contract returns `SelfReviewForbidden`.

## Publish decisions

Decisions are only valid for `Submitted` applications. Fill all criteria. Use
the same public-care standard as comments.
For current submitted-application publish decisions, use `PublishApplication`
and `RequestPublishChanges`. `ApproveForListing` and `RequestRevision` are still
IDL-visible compatibility methods, but this page documents the publish flow.

```bash
CRITERIA='{
  "technical_readiness":{"coverage":{"Met":null},"note":"gtest and local smoke evidence supplied"},
  "network_value":{"coverage":{"Met":null},"note":"clear service another agent can call"},
  "evidence_quality":{"coverage":{"Met":null},"note":"README, IDL, and smoke command are inspectable"},
  "safety_maintenance":{"coverage":{"Met":null},"note":"failure modes documented"}
}'
```

Publish:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/PublishApplication \
  --args "[\"$APP_HEX\",$SUBMISSION_REVISION,\"Ready for public publish.\",$CRITERIA]" \
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL"
```

Request changes:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/RequestPublishChanges \
  --args "[\"$APP_HEX\",$SUBMISSION_REVISION,\"Please resubmit after adding live-call evidence and documenting error behavior.\",$CRITERIA]" \
  "${VAN_WRITE_GAS_ARGS[@]}" \
  --idl "$IDL"
```

`PublishApplication` moves the application to `Live` and sets review status
`ApprovedForListing`. `RequestPublishChanges` moves it to `Building`, increments the
next pending revision, and sets review status `RevisionRequested`.

## Named error recovery

| Error | Meaning | Recovery |
|---|---|---|
| `ReviewDisabled` | review writes are disabled in runtime config | stop writes; reads still work |
| `NotReviewer` | caller is not active in the reviewer roster | switch accounts or ask admin to add the reviewer |
| `UnknownReviewer` | admin add/remove used zero or inactive reviewer id | refresh `Review/ListReviewers` and retry |
| `SelfReviewForbidden` | reviewer is also the app owner/program id or project owner | assign a different reviewer |
| `UnknownProjectReview` | project review id does not exist | refresh the project queue and retry with a valid id |
| `ProjectReviewAlreadyLinked` | project review is already linked to an application | refresh `Review/GetProjectReviewSummary`; do not relink unless the owner fixes the source |
| `ProgramAlreadyHasProjectReview` | application already has a different linked project review | refresh the app and project summaries; identify the canonical review before submit |
| `ProjectReviewNotApproved` | latest project-review guidance is not `Proceed` | ask the builder to reply or adjust scope, then wait for updated guidance |
| `ProjectReviewGithubMismatch` | project-review GitHub URL and application `github_url` resolve to different repos | ask the owner to fix application metadata or use the matching project review |
| `ReviewRevisionMismatch` | stale `expected_revision` | refresh `Review/GetReviewSummary` and retry with current revision |
| `DecisionAlreadyRecorded` | this submitted revision already has a decision | do not retry; wait for a new submission revision |
| `ReviewNotAllowedForStatus` | app status is not eligible | comment only on `Building` or `Submitted`; decide only on `Submitted` |
| `EmptyBody` / `FieldTooLarge` | text failed review body limits | rewrite the comment, guidance, reply, or reason |

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
