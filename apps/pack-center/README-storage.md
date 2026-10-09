# Private local artifact adapter

`src/storage.ts` provides a local filesystem / private-volume adapter. It is **not an S3 implementation**. The application must enforce authorization, review state, retention, signing, and download policy before calling it. Do not expose this directory through a static HTTP server.

```ts
const store = await createLocalArtifactStore('/private/center/artifacts', {
  maxBytes: 160 * 1024 * 1024,
})
const artifact = await store.putFile(temporaryTar, expectedArtifactSha256)
const report = await store.putJson(validationReport, { maxBytes: 16 * 1024 * 1024 })
const download = await store.openStream(artifact.key)
// Caller checks signed metadata, sets exact length/digest headers, and handles stream errors.
```

API:

- `createLocalArtifactStore(root, options?)` → `Promise<LocalArtifactStore>`.
- `putFile(sourceFile, expectedSha256?, limits?)` and `putJson(value, limits?)` → `{key, sha256, sizeBytes}`.
- `verify(key, limits?)` → `{key, sha256, sizeBytes}` after a complete bounded hash scan.
- `getBytes(key, limits?)` → bounded `Buffer`; use a small limit for JSON reports/previews.
- `openStream(key, limits?)` → `{key, sha256, sizeBytes, stream}`; fully verifies before returning, then streams from that same open file descriptor and revalidates metadata/hash before stream completion. Always consume or destroy the stream.

All keys are exactly `sha256/<64 lowercase hexadecimal digits>`. Keys do not accept URL paths, remote locations, path traversal, suffixes, or filenames. Reports, archives, and previews can all use these keys; they must never be copied into an executable domain-pack tree. JSON uses the shared protocol's canonical byte encoding. `putJson` is for already-bounded in-memory structures; the HTTP layer must bound its input before parsing.

The default byte limit is 160 MiB and the hard configuration ceiling is 1 GiB. Per-request limits may only tighten the configured store limit. File copies and all hashing/read operations use 64 KiB chunks; `getBytes` intentionally accumulates at most the accepted byte limit.

## Filesystem invariants

The configured parent directory must already exist without symlink ancestors. The adapter creates only the configured root and its own children; it does not recursively create arbitrary parents or change existing permissions. Root, `.incoming`, `sha256`, and every published object directory must be real, current-user-owned `0700` directories. Symlink roots, symlink children, world-readable directories, source symlinks, source hardlinks, special files, writable published blobs, and published hardlinks are rejected.

Each object is stored as `sha256/<digest>/data`, with a single `0400` regular file. A write creates a unique private staging directory, streams and hashes its data, checks the expected digest, syncs the data and staging directory, and atomically renames the entire nonempty directory into `sha256`. On POSIX local filesystems, an existing nonempty directory cannot be overwritten by `rename`, so independent processes can safely race without file overwrite or stale lock handling. Existing content is fully verified and reused; corrupted/incomplete existing objects are rejected, never repaired silently. Successful publication syncs the destination directory and staging parent before returning.

Supported deployment storage is a local POSIX filesystem with atomic same-filesystem directory rename and meaningful `fsync`; do not assume the same durability on arbitrary network filesystems. Run the center under its own OS identity. `0700`/`0400` do not defend against root or another process using that same OS identity. A post-verification concurrent tamper is reported as a stream failure; HTTP consumers must check completion and signed digests and must never activate a partial download.

There is no deletion / garbage-collection API. A process killed before publication can leave a private orphan under `.incoming`; it cannot appear in the published namespace. A process killed after publication leaves the whole verified object visible. Retrying is idempotent. Any future staging cleanup or retention policy needs a separate design and must not infer permission to delete referenced release data.

## Reproduction

From `apps/pack-center`:

```sh
./node_modules/.bin/tsc -p tsconfig.json
node --test test/storage.test.mjs
```

The isolated suite uses fresh temporary directories and verifies canonical bytes, 24-way in-process writes, 6 independent writer processes, bounded file copies/reads, malformed keys, paths/links, inode-preserving reuse, corrupt-object rejection, same-FD stream reads, and actual child-process exits at three publication stages. Temporary test directories are removed only by the tests that created them. No production directory, service, database, or credential is used.
