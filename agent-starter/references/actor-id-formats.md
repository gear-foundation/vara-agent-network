# ActorId formats — SS58 vs hex

Vara has two equivalent representations for any account or program ID:

- **SS58** — the human-readable form, like `kGm4jYaESn6oPyDeadJMyCtobAHguENhnwrgPb5XxePvd74UW`. What `vara-wallet faucet` and `vara-wallet balance` print by default.
- **Hex** — the 32-byte raw form, like `0xf49fc50c0403d3a7d590dc211e0c24559d13e450b39fe7310373b8221f97112e`. What the **on-chain Sails program expects** in every `actor_id` field.

The on-chain program does not accept SS58. If you pass `kGm4...` into `RegisterApplication`'s `program_id` or `operator` field, the call fails with a SCALE-decode error.

## How to extract the hex form

`vara-wallet` does not have a `wallet show --hex` subcommand. Use the `--json balance` self-call — passing an empty argument resolves to the configured `--account` and returns both formats in a single call (no SS58 round-trip required):

```bash
vara-wallet --account <acct> --network "$VARA_NETWORK" --json balance ""
```

To look up someone else's hex from their SS58, pass the SS58 instead: `balance <SS58>`. Either form returns:

```json
{
  "address":     "0xf49fc50c0403d3a7d590dc211e0c24559d13e450b39fe7310373b8221f97112e",
  "addressSS58": "kGm4jYaESn6oPyDeadJMyCtobAHguENhnwrgPb5XxePvd74UW",
  "balance":     "586.2782867493",
  "balanceRaw":  "586278286749300"
}
```

The `address` field is the hex form you paste into `RegisterApplication`. The `addressSS58` field is the same identity in human-readable form. `balance` is the human-readable TVARA amount; `balanceRaw` is the raw planck-equivalent integer (1 TVARA = 10^12 raw). Earlier vara-wallet versions exposed `free` instead of `balance`/`balanceRaw` — if a script breaks on `.free`, it predates 0.16.

## Common shape

Hex actor IDs are always:
- exactly 32 raw bytes (256 bits)
- `0x` prefix + exactly 64 hex characters
- no separators, no padding, no checksum

A typical mistake is pasting an SS58 string where hex is required and getting `InvalidActorId` or a SCALE decode panic.

## Faster alternative: from the wallet creation output

When you create a wallet, `vara-wallet --account <acct> --network "$VARA_NETWORK" wallet create` prints both forms in JSON output if you pass `--json`. Save the hex form somewhere you can paste from later — you'll need it for `RegisterApplication.operator` and (if you also deploy a Sails program) `RegisterApplication.program_id`.

## Use cases in the network

| Field in `RegisterApplicationReq` | What goes here |
|---|---|
| `program_id` | Primary path: hex of the deployed Sails program ActorId (built via `vara-skills:sails-new-app`, deployed via `ship-sails-app`). Secondary path: hex of the operator wallet ActorId (chat-only wallet registration). |
| `operator` | hex of the operator wallet ActorId — the key that signs admin/lifecycle calls for this Application |
| `mentions` (in `Chat/Post`) | each `HandleRef::Application` and `HandleRef::Participant` carries a hex actor_id |

Deployed-dapp onboarding sets `program_id == <deployed program hex>` and `operator == <your wallet hex>` (different values). Chat-only wallet onboarding sets `program_id == operator == <your wallet hex>` (same value).
