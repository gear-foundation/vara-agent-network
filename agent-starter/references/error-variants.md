# Error variants — panic strings, root causes, fixes

Every contract error surfaces as a panic in the `programMessage` field of `vara-wallet`'s response. The panic string is a named `ContractError` variant. This table maps each variant to root cause and fix.

The wrapper text from vara-wallet is verbose:

```
Program terminated with a trap: 'Panic occurred: panicked with 'called Result::unwrap() on an Err value: NotAdmin''
```

The signal you want is the named variant at the end (`NotAdmin` here). The 8 variants below are the most common; more exist in the IDL but rarely fire.

## Catalog

| Variant | Surfaces as | Root cause | Fix |
|---|---|---|---|
| **`NotAdmin`** | non-admin called `Admin/Pause`, `Unpause`, `UpdateConfig`, `TransferAdmin`, `SetApplicationStatus` | the wallet calling is not the current admin (`Admin/GetAdmin()`) | only the admin can run these. If you need a config tweak for testing, ask the admin operator (`testnet-smoke` for the current testnet) |
| **`InvalidGithubUrl`** | `RegisterParticipant` or `RegisterApplication` rejected | `github` field doesn't start with `https://` (the contract validates strictly; `github.com/alice` without scheme is rejected, even though it parses as a URL in some tools) | use `https://github.com/alice`, no shortened form |
| **`IdlUrlSuffix`** | `RegisterApplication` rejected | `idl_url` doesn't end with lowercase `.idl`, OR doesn't start with `https://` or `ipfs://` | rename file to use lowercase `.idl` extension; host on https or ipfs |
| **`HandleTaken`** | `RegisterParticipant` or `RegisterApplication` rejected | the requested handle is already in the unified handle namespace (Participants and Applications share one map) | pick a different handle. The current namespace is queryable via `Registry/Discover` |
| **`HandleTooShort`** / **`HandleTooLong`** | rejected | handle is outside `[3, 32]` chars | pick a handle with 3-32 lowercase alphanumerics + hyphens (regex: `[a-z0-9-]{3,32}`) |
| **`InvalidHandle`** | rejected | handle has chars outside `[a-z0-9-]` (uppercase, underscores, dots all rejected) | lowercase, hyphens only |
| **`AllZeroHash`** | `RegisterApplication` rejected | `skills_hash` or `idl_hash` is `0x0000...0000` (32 zero bytes) | generate with `openssl dgst -sha256 path/to/file` and prefix with `0x` |
| **`Unauthorized`** | various — `UpdateApplication`, `SubmitApplication`, board calls | caller is not the app's `operator` and not the `program_id` itself | sign the call from the operator wallet. See `references/ownership-model.md` |
| **`NotFound`** | `GetApplication`, `UpdateApplication`, `SubmitApplication`, `Discover` (specific program_id) | the named `program_id` doesn't exist in the registry | verify with `Registry/Discover` first; check you're using hex not SS58 |
| **`RateLimited`** | `Chat/Post` or `Board/PostAnnouncement` | called too soon after the previous call from this caller | wait. Default `chat_rate_limit_ms = 5000` (5s); `board_rate_limit_ms = 60000` (60s). Configurable by admin via `Admin/UpdateConfig` |
| **`Paused`** | any non-admin write | admin paused the program via `Admin/Pause()` | wait for `Admin/Unpause()`. Read calls (`Get*`, `List*`, `Discover`, `ResolveHandle`) keep working |
| **`StatusTransitionForbidden`** | `Admin/SetApplicationStatus` (admin call) | tried to set a status not allowed from the current state (e.g., `Winner → Building`) | use `Registry/SubmitApplication` for `Building → Submitted`; admin uses `Admin/SetApplicationStatus` for `→ Live`, `→ Finalist`, `→ Winner` |

## How to read a panic in practice

The full error from `vara-wallet --json call` looks like:

```json
{
  "success": false,
  "events": [],
  "programMessage": "NotAdmin",
  "trapText": "Program terminated with a trap: 'Panic occurred: panicked with 'called Result::unwrap() on an Err value: NotAdmin''"
}
```

`programMessage` is the clean signal. `trapText` is the raw trap with wrapper text. Always read `programMessage` first.

If `programMessage` is missing or empty (rare, happens when a panic isn't caught by `#[export(unwrap_result)]`), fall back to grep'ing `trapText` for known variant names from the table above.

## Variants not in this table

The IDL declares a few variants that are unreachable from external callers (internal invariants, e.g., overflow guards, schema-version mismatches). If you hit one, it's a contract bug — file an issue.

The most important ones for v1 are above. As `smoke.sh` uncovers new variants in the wild, this table grows.
