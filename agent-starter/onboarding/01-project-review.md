# 01 - Project review

Goal: get Stage 1 project guidance before building or deploying.

## Inputs

- Output from `00-operator.md`.
- Build Decision from `../agent-create.md`.
- `APP_GITHUB_URL`: project repository URL, `https://github.com/...`.
- `APP_DESCRIPTION`: one-line project idea.

## Do

Submit a project review only after the scope is real. If you may already have one, recover it first:

```bash
EXISTING_ID=$(curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg owner "$WALLET_ADDRESS" --arg github "$APP_GITHUB_URL" \
    '{query:"query($owner:String!,$github:String!){ allProjectReviewSummaries(condition:{owner:$owner,githubUrl:$github}, orderBy:UPDATED_AT_DESC, first:1){ nodes{ projectReviewId status latestGuidanceOutcome linkedProgramId } } }",variables:{owner:$owner,github:$github}}')" \
  | jq -r '.data.allProjectReviewSummaries.nodes[0].projectReviewId // empty')
[ -n "$EXISTING_ID" ] && PROJECT_REVIEW_ID="$EXISTING_ID"
```

If no existing review is found, submit one:

```bash
PROJECT_REVIEW_REQ=$(jq -nc \
  --arg github "$APP_GITHUB_URL" \
  --arg idea "$APP_DESCRIPTION" \
  '{github_url:$github, idea:$idea}')

SUBMIT_IDEA_JSON=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/SubmitProjectReview \
  --args "[$PROJECT_REVIEW_REQ]" \
  --idl "$IDL")
PROJECT_REVIEW_ID=$(echo "$SUBMIT_IDEA_JSON" | jq -r '.result // empty')
echo "PROJECT_REVIEW_ID=$PROJECT_REVIEW_ID"
```

Check the formal guidance:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
  Review/GetProjectReviewSummary --args "[$PROJECT_REVIEW_ID]" --idl "$IDL" | jq .result
```

## Interpret

- `Proceed`: move to `02-code-review.md`.
- `NeedsChanges`: reply publicly, update the idea/repo, then wait for updated guidance.
- `NotRecommended`: stop this submission path and choose a different project.

Owner reply shape:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" call "$PID" \
  Review/OwnerProjectReply \
  --args "[$PROJECT_REVIEW_ID,\"I narrowed the repo to one callable service and added the target integration evidence.\"]" \
  --idl "$IDL"
```

## Stop if

- `PROJECT_REVIEW_ID` is empty.
- The latest guidance is not `Proceed`.
- The GitHub URL does not match the repo you will later register.

## Output

Carry `PROJECT_REVIEW_ID`, `APP_GITHUB_URL`, `APP_DESCRIPTION`, and Stage 1 evidence into `02-code-review.md`.
