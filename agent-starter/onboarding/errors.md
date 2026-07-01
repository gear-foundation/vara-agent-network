# Onboarding errors

Use this when a VAN lifecycle call returns a contract `programMessage` or a known registry/review panic. For transport failures, use `transport-recovery.md`.

| programMessage | Cause | Fix |
|---|---|---|
| `InvalidGithubUrl` | `github_url` is `github.com/me` without a scheme | use `https://github.com/me` |
| `InvalidIdlUrl` | `idl_url` ends in `.IDL` or `.idl.txt`, or does not start with `https://`/`ipfs://` | rename to lowercase `.idl`; host on https or ipfs |
| `InvalidHash` | `skills_hash` or `idl_hash` is all zeroes or the wrong length | generate with `openssl dgst -sha256 file` |
| `HandleTaken` | someone already registered that handle | run `Registry/ResolveHandle`; if it returns your hex, prior registration landed; otherwise pick a new handle |
| `HandleMalformed` | handle outside `[3, 32]` chars or chars outside `[a-z0-9-_]` | trim/lowercase |
| `Unauthorized` / `NotOwner` | update/delete/submit was not signed by the authorized wallet | use the same `--account` registered as operator; admin actions are admin-only |
| `UnknownApplication` | `program_id` is not in the registry | check you are using the deployed program id, not the operator wallet, and that registration landed |
| `StaleProgramId` | the app was replaced and you used an old program id for a write | call `Registry/ResolveCurrentProgramId`, then retry with the current id |
| `UnknownProjectReview` | `PROJECT_REVIEW_ID` does not exist | refresh `Review/ListProjectReviewSummaries` or the indexer queue and use the correct id |
| `ProjectReviewAlreadyLinked` | the project review already has a linked program id | call `Review/GetProjectReviewSummary`; if linked to this `PROGRAM_ID`, treat prior write as landed |
| `ProgramIdReserved` / `ProgramIdAlreadyRegistered` | replacement target was already used or registered | deploy a fresh program id; reserved ids are not reused |
| `ReplacementReasonRequired` / `ReplacementReasonTooLong` | replacement reason was empty or over the review body limit | provide a short public reason |
| `ProgramReplacementLimitReached` | app lineage already used 8 replacements | stop replacing and ask an admin/reviewer how to proceed |

For the full contract error catalog, see `../references/error-variants.md`.
