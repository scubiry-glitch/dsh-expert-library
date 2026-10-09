# Fixed-snapshot release publisher

`createPublisher({ database, store, centerId, signingKeyId, signingPrivateKey, workerId, scratchRoot, leaseMs?, builtinPackVersions? }).runOnce()` claims only `publish_release` jobs. It returns `idle`, `published`, `yanked`, `failed`, `retrying`, or `lease_lost`, with job/release identifiers where available. A job payload must contain exactly `{ releaseId, snapshotId }`.

`scratchRoot` is mandatory: an existing, owned, real `0700` directory on the deployment's quota-limited scratch volume. Archive download/extraction use an owned temporary child there, cleaned after verification. There is no system `/tmp` fallback. The application does not create or prove a filesystem quota; deployment must supply and exercise that resource boundary for both workers.

This is a signing worker, **not** a Git-fetch or human authorization interface. It never fetches the submission's Git URL, resolves branches, runs repository scripts, or chooses replacement dependency versions. Its private key must be injected through the host's credential mechanism; do not store real keys in Git, a vault, reports, test fixtures, or logs. Git-validation workers should run separately without this credential. Only Ed25519 private keys are accepted.

## Publication checks

Before signing, the publisher checks:

- Release, approved submission, immutable snapshot, reviewer decision, and reviewed tree hash agree. The reviewer is not the author.
- Archive/report keys exactly identify the frozen SHA-256 bytes. The canonical stored report matches its database copy, shared report schema, validator version, and valid result.
- The stored tar's byte length/hash, extracted tree hash, and file count match the snapshot. The shared pure loader validates the extracted local pack; its ID, version, schema, and dependency declarations match the approved release.
- `snapshot.preview.delivery` contains exactly `requiresPlugin`, `dependencyLock`, and `builtinDependencies`. It is the signing source; it must also match the original frozen submission requirements. Missing or conflicting delivery metadata is not silently defaulted.
- All direct and transitive locked dependencies still exist as published releases, their identity/digests match their fixed locks, and their current distribution covers both the author organization and every approved target recipient. Cycles, multiple releases of one pack, center/built-in identity conflicts, and out-of-range/unconfigured built-ins are rejected. `selected` scope never implicitly grants the owner organization access.

Dependency checks are shared with validation and repeated inside both signing-freeze and final-publication transactions. PostgreSQL shared locks prevent dependency withdrawal or scope narrowing during the successful publication transaction. Checks can refuse an unavailable dependency; they cannot change a reviewed lock.

## Crash and concurrency protocol

1. Claim a durable PostgreSQL job and renew its lease periodically.
2. Re-verify private immutable snapshot bytes outside long database transactions.
3. In a transaction fenced by the current job token **before and after writes**, fix `releases.signed_manifest` once. The release remains `publishing`.
4. Store those exact canonical envelope bytes using the content-addressed artifact store. The manifest key is `sha256/<SHA256(canonicalBytes(signed_manifest))>`; there is no separately mutable manifest path.
5. Recheck dependencies and atomically transition the release to `published`, append the audit event, and complete the job using `withJobTransaction`. Its end-of-transaction lease check rolls back stale-worker writes and audit events.

Ed25519 signing is deterministic for the same manifest/key. More importantly, a retry after step 3 always reuses the immutable database envelope. A crash before the store write can safely restore the same CAS object. A key ID or key-material change during recovery produces `PUBLISH_KEY_MISMATCH`; it never re-signs the version under the replacement key. Restore the original credential and enqueue an explicitly authorized retry job.

A permanent validation failure or exhausted attempt becomes `publish_failed`; failed writes do not delete approved snapshots, artifacts, frozen manifests, or previous releases. Last-attempt lease expiry is reconciled from failed durable jobs so the release does not remain `publishing` forever. Transient storage/database errors have bounded retry behavior; diagnostics persist static messages and error codes, not arbitrary exception strings or credentials.

Retries of already-published releases retain the same signature, state version, and original publication audit event. A retry of a yanked release never unyanks it or broadens distribution. Database constraints independently forbid deleting releases or overwriting an existing version, snapshot identity, or signed envelope.

Human retry authorization belongs to the API/service layer. After checking role, release status, expected state version and idempotency, it may enqueue a new `publish_release` job (for example `publish-retry:<releaseId>:<stateVersion>`). The publisher accepts `publish_failed` recovery and moves it back to `publishing` under the new job fence. There is no public unauthenticated `retryRelease()` entry point here.

## Reproduction

```sh
cd apps/pack-center
./node_modules/.bin/tsc -p tsconfig.json
node --test test/publisher.test.mjs
```

Tests use real PostgreSQL in a uniquely labelled temporary container, real private CAS files, actual tar extraction and pure pack validation, and newly generated ephemeral signing keys. They cover concurrent publishers, duplicate jobs, immutable signatures/versions, malformed frozen requirements, tampered reports/archives, direct/transitive dependency withdrawal and scope narrowing, built-in compatibility, actual worker-process exits before/after CAS persistence, key-change recovery, final-transaction lease expiry, exhausted-crash reconciliation, and yanked-release replay. The fixture removes only its own temporary directories and labelled container/volume. No production service, DNS record, or credential is touched.
