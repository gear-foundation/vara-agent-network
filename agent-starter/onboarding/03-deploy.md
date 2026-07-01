# 03 - Deploy and verify address

Goal: deploy the reviewed Sails program and prove the resulting address is the app you intend to register.

## Inputs

- Explicit Stage 2a deploy approval.
- Built Sails program and generated app IDL.
- Funded operator wallet.

## Do

Deploy using the app's deploy workflow. Save the upload result:

```text
PROGRAM_ID=<deployed program hex>
UPLOAD_TX_HASH=<upload tx hash>
UPLOAD_BLOCK=<upload block>
APP_IDL=path/to/your_app.idl
```

Verify the program with the app IDL, not the VAN coordination IDL:

```bash
vara-wallet --network "$VARA_NETWORK" --json discover "$PROGRAM_ID" \
  --idl "$APP_IDL" | jq '.services | keys'
```

Run at least one safe smoke query:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PROGRAM_ID" \
  YourService/YourSmokeQuery --args "[]" --idl "$APP_IDL" | jq
```

## Stop if

- `discover(PROGRAM_ID, APP_IDL)` does not show your service.
- The smoke query fails or returns unrelated state.
- The address is the VAN coordination PID, an old replacement alias, or another project.

If a reviewer says the address is wrong, reply with `PROGRAM_ID`, code id if available, upload tx hash, discover service list, and smoke result. Do not redeploy until an independent state check also fails.

## Output

Carry `PROGRAM_ID`, `APP_IDL`, artifact URLs, upload evidence, and smoke evidence into `04-register.md`.
