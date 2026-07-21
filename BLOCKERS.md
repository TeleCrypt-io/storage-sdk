# BLOCKERS

## Production upload tests (P.1, P.2, P.3) cannot pass via a plain redpill account — verified root cause, not a bug

**Status: root-caused, not fixed here (fix, if any, belongs in `server/`, not this repo). Tests left as originally specced — not faked, not weakened.**

### What happens

Every test in `test/production/storage.test.ts` that calls `core.uploadFile` (P.1 encrypted
round-trip, P.2 multi-participant share, P.3 server-never-sees-plaintext) fails against real prod
with:

```
MatrixError: [413] Upload request body is too large (https://telecrypt.io/_matrix/media/v3/upload)
```

This reproduces even for a **0-byte** upload, bypassing this library entirely (raw `curl`, fresh
redpill token each time):

```
$ curl -sS -X POST "https://telecrypt.io/_matrix/media/v3/upload?filename=empty.bin" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @/dev/null
{"errcode":"M_TOO_LARGE","error":"Upload request body is too large"}
```

Meanwhile `GET /_matrix/media/v3/config` (same token) reports:

```
{"m.upload.size": 157286400}
```

150 MiB advertised, 0 bytes rejected — impossible from a plain size check, which is what led to
digging further instead of assuming a broken proxy/edge.

### Root cause (found in `server/synapse/modules/tier_controller/__init__.py`)

telecrypt.io runs a Synapse module, `tier_controller.TierController`, implementing an **inverted
tier model**: every account is `RESTRICTED` by default — no media uploads, a capped number of
created rooms (`restricted_room_cap: 3`), no `m.room.encryption` state events — unless its
`user_type` column is explicitly `'verified'` in Synapse's `users` table. `NULL`/absent
`user_type` (the default for every freshly registered account, human or agent) is restricted,
fail-closed, by design:

```python
async def is_user_allowed_to_upload_media_of_size(self, user_id: str, size: int) -> bool:
    return not await self._is_restricted(user_id)
```

`is_user_allowed_to_upload_media_of_size` returning `False` is exactly what Synapse's
`upload_resource.py` surfaces as the hardcoded client message `"Upload request body is too
large"` regardless of the actual size — a module can't attach its own message on this callback
(documented in the module's own file-header comment, confirmed against the installed Synapse
1.155.0 source). That explains the misleading errcode: it isn't a size problem at all.

**Redpill-provisioned accounts are never `verified`.** `controlplane`'s
`internal/agent/provision.go` registers through MAS's public registration form and logs in — it
never touches `user_type`. Becoming `verified` requires the account owner's own out-of-band
verification step (`tc-verify.sh`, referenced in the module's docstring: "the owner's
verification script setting `user_type='verified'`") — an explicit, human, admin-DB action. This
is deliberate: it's the product's payment/verification boundary (see this repo's
`docs/DECISIONS.md`-adjacent product thesis — payment/verification, not "proof of humanity", is
what unlocks real usage), not an accident.

### Why this can't be worked around within this task's constraints

The whole point of `redpill` for this test suite is **zero secrets, zero admin credentials** —
that's what makes prod testing runnable from an unauthenticated GitHub Actions job. Making a
redpill-provisioned account `verified` requires exactly the kind of privileged, human/admin-DB
action redpill was built to avoid needing. There is no secrets-free way to get a "verified"
throwaway account for CI.

### What this means for the suite as built

- **P.4 (recovery setup)** does not touch the media repo at all (`bootstrapCrossSigning` +
  `bootstrapSecretStorage` + key-backup only touch account_data/room_keys endpoints, which the
  tier_controller module doesn't gate) — **it passes against real prod**, verified live.
- **P.1/P.2/P.3** are left exactly as specced in `docs/PROD_TESTING_SPEC.md` — asserting the real,
  intended behavior (a genuinely usable account can round-trip an encrypted file on real infra).
  They are **not** `.skip`ped, `.todo`ed, or rewritten to assert the 413 instead — that would
  quietly change what the test claims to prove. They will fail deterministically on every future
  `npm run test:prod` run until one of:
  1. Product policy changes to give unverified/agent accounts some upload allowance, or
  2. A secrets-free way exists to provision a *verified* throwaway account for testing, or
  3. Someone deliberately decides these three tests should instead assert the *denial* (a
     different, valid test — "unverified accounts are correctly denied uploads" — but a
     different claim than what Part A of the spec asked for, so not substituted here without
     that being a deliberate call by the repo owner).

### Practical effect on `.github/workflows/prod-tests.yml`

Every automatic post-deploy run will currently show **3 failing / 1 passing** in Part A. This is
expected, not a regression signal, until one of the above changes — worth knowing before treating
a red run as an incident. The workflow is left wired exactly as specced (loud failures, no
rollback) since "don't fake it" extends to not quietly muting a real, structural finding.
