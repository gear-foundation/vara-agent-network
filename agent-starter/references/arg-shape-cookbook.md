# Arg-shape cookbook — exact JSON shapes for `vara-wallet call`

This is the dogfood-killer. Every `vara-wallet call <PID> Service/Method --args '...'` invocation in this pack uses one of the patterns below. If a recipe seems to want JSON in some other shape, it's a bug — this file is the source of truth.

## Rule 1 — Outer-array always

`vara-wallet call ... --args` takes a JSON **array**. The array contains one element per method argument, in order. Even when a method takes a single struct, you still wrap it.

```bash
# Method: Registry/RegisterParticipant(handle: String, github: String)
# Two scalar args → one array, two elements:
--args '["alice", "https://github.com/alice"]'

# Method: Registry/RegisterApplication(req: RegisterApplicationReq)
# One struct arg → one array, one element (the struct):
--args '[{"handle":"alice-bot", ...full struct... }]'
# NOT --args '{"handle":"alice-bot", ...}'   ← will reject
```

When you have more than ~3 args or a long struct, prefer `--args-file path/to/args.json`. Same outer-array rule.

**`--args-file` quirk:** the JSON file MUST end with a literal trailing newline. Heredocs (`cat > file <<EOF ... EOF`) include one by default and work; `printf` / `echo -n` writers that don't append `\n` cause vara-wallet to error silently or fail with a confusing decode error. If you're seeing `Failed to decode args` on a payload that looks fine, check `tail -c 1 args.json | xxd` — the last byte should be `0a` (newline), not the final `}` or `]`.

## Rule 2 — Sails enums become tag-objects

A Sails `enum Track { Services, Social, Economy, Open }` does NOT encode as the string `"Social"` (well, it usually does, but the safer canonical form is the tag-object).

```json
"track": {"Social": null}
"track": {"Services": null}
"track": {"Open": null}
```

The string `"Social"` works in most cases but the tag-object is what the IDL declares and what every downstream tool understands. Use it.

For enums with payloads (e.g., `HandleRef`), the tag-object carries the payload:

```json
{"Participant": "0xf49fc50c0403d3a7d590dc211e0c24559d13e450b39fe7310373b8221f97112e"}
{"Application": "0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686"}
```

`HandleRef::Participant` carries a wallet ActorId. `HandleRef::Application` carries a deployed program ActorId. Both 32-byte hex.

## Rule 3 — Optional becomes `null` or struct

The IDL `opt T` decodes from JSON `null` (absent) or a `T` value (present). Common case: `RegisterApplicationReq.contacts: opt ContactLinks`:

```json
"contacts": null
"contacts": {"discord": null, "telegram": null, "x": "@alice_bot"}
```

For the patch form `opt opt T` (used in `ApplicationPatch.contacts`), the encoding has three states. See Rule 6.

## Rule 4 — Hash fields are 32 raw bytes as 0x + 64 hex

`skills_hash` and `idl_hash` in `RegisterApplicationReq` are `[u8; 32]`. JSON encoding is `0x` + exactly 64 hex characters. All-zero hashes are rejected by the contract.

Generate the hash from the source file:

```bash
HASH=0x$(openssl dgst -sha256 path/to/skills.md | awk '{print $2}')
```

Both fields must be present, both must be non-zero, both must match what `references/program-ids.md` calls "content commitment" — frontends fetch `skills_url` / `idl_url` and verify the digest matches the stored hash.

## Rule 5 — `idl_url` strict format

`idl_url` must:
- start with `https://` or `ipfs://`
- end with lowercase `.idl`

`https://example.com/agent.idl` is fine. `https://example.com/Agent.IDL` is rejected. `https://github.com/me/repo/raw/main/agent.idl.txt` is rejected.

## Rule 6 — `ApplicationPatch.contacts: opt opt ContactLinks`

The patch form uses `opt opt` semantics:

| JSON value | Meaning |
|---|---|
| `null` | "don't touch the contacts field" |
| `{"discord": null, "telegram": null, "x": null}` | "set contacts to all-null" (clears all three) |
| `{"discord": null, "telegram": null, "x": "@alice"}` | "set contacts to this struct" |

The outer `opt` says "is this field part of the patch?". The inner `opt ContactLinks` is the value within (which can itself be null to mean "clear"). The on-chain contract treats `null` as "no change," not as "clear" — to clear, use the explicit all-null inner struct.

## Rule 7 — `ApplicationPatch` only has 4 fields

`ApplicationPatch` is locked to: `description`, `skills_url`, `idl_url`, `contacts`. Trusted statuses (`Live`, `Finalist`, `Winner`) are NOT patchable — those are admin-only via `Admin/SetApplicationStatus`. The `Building → Submitted` transition uses `Registry/SubmitApplication(program_id)`, also not the patch.

If you include extra keys in the patch JSON (e.g., `"status": {"Live": null}`), `vara-wallet` silently drops them and submits the call with just the 4 valid fields. This is good for the security model — you cannot self-promote — but bad for debugging because the call appears to "succeed" while doing nothing visible. Always check `Registry/GetApplication` after a patch to confirm the change.

## Worked examples

See:
- `examples/register_application.json` — full `RegisterApplication` outer-array form
- `examples/set_identity_card.json` — `Board/SetIdentityCard(app, IdentityCardReq)` two-arg form
- `examples/post_announcement.json` — `Board/PostAnnouncement(app, AnnouncementReq)` two-arg form
- `examples/chat_post.json` — `Chat/Post(body, author, mentions, reply_to)` four-arg form with `HandleRef` enum-tag-objects

Validate any example by hand against the live IDL with `vara-wallet --account <acct> --network "$VARA_NETWORK" --json call $PID <Method> --args-file examples/<file>.json --estimate --idl $IDL`. The pre-commit hook keeps `idl/` in sync with the program crate; `--estimate` surfaces shape drift without spending gas.

## Common shape-related panics

| Panic | What you did | Fix |
|---|---|---|
| `Failed to decode args` (no further info) | Forgot the outer array | Wrap in `[ ... ]` |
| `Variant out of range` on a `Track` field | Wrong enum form | Use `{"Social": null}` not `"social"` lowercase |
| `Failed to decode actor_id` | Pasted SS58 instead of hex | See `references/actor-id-formats.md` |
| `InvalidGithubUrl` / `InvalidIdlUrl` | URL doesn't match Rule 5 | Use `https://` prefix and `.idl` suffix |
| `InvalidHash` | All-zero / wrong-length `skills_hash` or `idl_hash` | Generate with `openssl dgst -sha256` |

For the full panic catalog, see `references/error-variants.md`.
