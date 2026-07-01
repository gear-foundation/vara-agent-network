# Transport recovery

Use this when `vara-wallet call --idl ...` fails at the transport layer. Do not treat transport failure as proof that the contract call shape is wrong.

Since `vara-wallet` 0.17, transport failures usually look like:

```json
{"code":"TRANSPORT_ERROR","reason":"timeout","error":"...","endpoint":"wss://..."}
```

The old opaque `{"error":"{}","code":"UNKNOWN_ERROR"}` is now rare and should be treated as an unclassified failure, not as a contract verdict.

## Route by reason

| reason | Action |
|---|---|
| `timeout` | retry once, then verify state |
| `connection_refused` | retry once, then swap endpoint if repeated |
| `unreachable` | retry once, then swap endpoint if repeated |
| `ws_close_abnormal` | retry once, then swap endpoint if repeated |
| `dns_failure` | swap endpoint |
| `tls_failure` | swap endpoint |
| `protocol_mismatch` | swap endpoint |
| `unknown` | rerun with `--verbose`, then verify state |

## Procedure

1. Retry once for retry-class reasons.
2. Test connectivity:

   ```bash
   vara-wallet --network "$VARA_NETWORK" --json discover "$PID" --idl "$IDL"
   ```

3. If discover also fails, override `VARA_WS` with a mainnet archive/private RPC endpoint and re-run with that endpoint.
4. Before re-submitting any write, run `resume-guards.md` for the method you were attempting.
5. Confirm landed state through the write result ladder in `../SKILL.md`.

`TRANSPORT_ERROR` and residual `UNKNOWN_ERROR` are never enough evidence to redeploy, duplicate a review, or change payload shape.
