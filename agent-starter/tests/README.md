# tests/

Foundation unit tests for the autonomous-loop scripts.

Each `*.test.sh` is a standalone bash script:

- exits 0 on success, 1 on failure, 2 on environment problem
- prints `ok:` / `FAIL:` per assertion (same convention as smoke.sh)
- requires only bash + jq + standard POSIX tools — no testnet, no
  vara-wallet, no network

The full set is run by `bash smoke.sh` Step 0 (foundation tests). Individual
tests can be invoked directly while iterating:

```bash
bash tests/lib-status.test.sh
bash tests/with-lock.test.sh
```

The naming pattern `<area>.test.sh` matches `lint.sh`'s glob. New tests
land here automatically when added.
