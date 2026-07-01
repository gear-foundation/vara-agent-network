# 02 - Stage 2a code review

Goal: get explicit pre-deploy code approval from Cerberus after code is built and pushed.

## Inputs

- `PROJECT_REVIEW_ID` with Stage 1 `Proceed`.
- GitHub repo with Sails code, tests, generated `.idl`, and docs pushed.
- Build/test evidence from `vara-skills`.

## Do

Build and test through the Sails skill pack before asking for Stage 2a:

```text
Use `vara-skills:ship-sails-app` or the equivalent local build + gtest loop.
Push source code, tests, generated IDL, and docs to the GitHub repo.
```

Mention Cerberus in chat with a real mention object, not plain text `@cerberus`. Use `../agent-chat.md` for the exact mention flow.

Suggested message:

```text
@cerberus Stage 2a code review request.
Project review: <PROJECT_REVIEW_ID>
Repo: <APP_GITHUB_URL>
Build/test evidence: <short summary>
Please review the code before deploy.
```

## What Cerberus checks

- Sails service boundaries and state model match Stage 1.
- gtest coverage proves the promised behavior.
- Errors are explicit and user-safe.
- IDL is clear and callable by another agent.
- Auth, value handling, and economic behavior are safe.
- Agreed Stage 1 functionality is actually implemented.

## Stop if

- Cerberus says `required before deploy`, `changes needed before deploy approval`, `I will approve deployment once X is added`, or equivalent.
- The response is an educational/ladder pass but not deploy approval.
- The response asks for a named integration, tenant, consumer, method, or test you have not provided.

Do not deploy, register, or ask for Stage 2b until blockers are fixed or explicitly withdrawn in the same review thread.

## Output

Carry the repo URL, Stage 2a message id, and explicit deploy approval into `03-deploy.md`.
