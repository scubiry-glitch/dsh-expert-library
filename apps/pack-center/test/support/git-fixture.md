# C03 Git snapshot transport evidence

Run from `apps/pack-center` after the plugin pure-validator build exists:

```sh
npm run build
node --test test/git-snapshot.test.mjs
```

The fixture starts a real `git-http-backend` behind an ephemeral loopback HTTPS
server with a one-day, temporary, test-only certificate. Its private key is removed
with its owned temporary directory. It creates/pushes only its own local bare Git
repository; it never pushes a user's remote repository.

The production entry `fetchGitSnapshot` exposes no HTTP/private-network/CA/proxy
override. The test uses the trusted infrastructure factory: production source and
DNS checks first see a public IP, then a test-only spawn adapter replaces exactly
that one destination with the loopback fixture and supplies its CA. The actual
Git TLS transport, all isolation flags, raw object reading, shared V2 validator,
deterministic archive writer, limits and cleanup still execute. This is not proof
of production DNS/TLS infrastructure, container quota or real-domain deployment.

Verified local version: Git 2.43.7. Required worker platform: Linux with
`/usr/bin/git`, `/usr/bin/prlimit`, and trusted system TLS roots. The module rejects
Git older than 2.43. Raw blobs use `cat-file blob` and never checkout/filter flags.

Primary upstream references used:

- [Git 2.43 configuration](https://git-scm.com/docs/git-config/2.43.0):
  `http.curloptResolve` pins the approved address while preserving TLS hostname;
  `http.followRedirects=false` rejects redirects; protocol policies restrict Git
  helpers. Isolated HOME plus an environment allowlist disables inherited
  credentials, configuration, proxies and loader hooks.
- [Git cat-file](https://git-scm.com/docs/git-cat-file/2.42.1): raw object bytes
  differ from the explicitly requested `--filters`/`--textconv` modes.
- [Git ls-tree](https://git-scm.com/docs/git-ls-tree): NUL-terminated, unquoted
  filenames permit byte-validating names without shell interpolation.
- [Git remote-curl 2.43.7 source](https://github.com/git/git/blob/v2.43.7/remote-curl.c#L1083-L1094):
  shallow fetch rejects dumb HTTP before the HTTP object walker, preventing an
  untrusted alternates file from choosing another destination. `--depth=1` is a
  security invariant, not merely an optimization.

Limits include deadline/process-group cancellation, bounded stdout/stderr,
RLIMIT file size/address space/CPU/fd limits, sampled aggregate scratch usage,
expanded Git object count/bytes, extracted file count/bytes/depth, archive bytes
and UTF-8-safe preview bytes. RLIMIT_FSIZE is **per file** and the disk sampler can
overshoot between samples. Production must use a dedicated non-root worker with
a quota-limited scratch filesystem/container volume and memory/CPU/PID limits;
these component tests do not prove a hard aggregate disk quota. Forced process
death may leave a hidden `.git-snapshot-*` directory, never a completed
`snapshot-*`; external cleanup must remove only expired unreferenced tasks.

Validation failures retain a fixed archive/report for diagnostics, with
`report.valid=false`. The caller must gate submission/publish on this flag,
compare pack ID/version with the submitted identity, validate dependencies and
distribution permissions, persist artifact/report to immutable storage, and
then attach them transactionally to the submission. Git transport errors throw
stable error codes without copying remote stderr into a user response. Successful
results are caller-owned; dispose of `snapshotDir` after durable storage.
