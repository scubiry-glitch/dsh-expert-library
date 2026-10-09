# Release governance

`createReleaseGovernance({ database, identity })` handles human management of a
release after publication. It has no Git transport, object-store credentials,
private signing key, machine-token issuer, or local-client deletion capability.

## API and versions

| Method | Mutation input | Version compared |
| --- | --- | --- |
| `yank(actor, releaseId, input, operationKey)` | `{ expectedVersion, reason }` | Release `stateVersion` |
| `requestDistribution(actor, releaseId, input, operationKey)` | `{ expectedVersion, scope, reason }` | Distribution `stateVersion` |
| `reviewDistribution(actor, requestId, input, operationKey)` | `{ expectedVersion, decision, comment }` | Request `stateVersion` |

`decision` is `approved` or `rejected`. Reasons and comments are required,
nonblank, at most 4,000 characters. Requests start at version 1 and capture the
exact distribution version they propose to replace. The approval transaction
checks both request version and distribution version. A stale request can still
be explicitly rejected, including after its release was yanked, but cannot be
approved against a newer scope.

Read methods are `get(actor, releaseId)`, `getRequest(actor, requestId)`,
`listReleaseRequests(actor, releaseId, { limit?, beforeId? })`, and
`listReviewQueue(actor, organizationId, { limit?, beforeId?, status? })`.
Lists return `{ items, nextCursor }`; `limit` is 1–100, default 50. Cursors use
stable descending request IDs, not a chronological creation-time promise.
The review queue defaults to `pending_review`.

`get` returns release metadata with `{ distribution: { scope, stateVersion } }`.
A request returns its own `stateVersion` and `expectedDistributionVersion`.
Approval/rejection returns `{ request, distribution }`. No management response
contains sessions, machine credentials, signed download tokens, object keys,
or private signing material.

## Authorization and transaction boundaries

- Requesting any scope change, including narrowing, requires current owner
  organization `admin` permission (platform administration is also accepted by
  the identity service). Requesting does not immediately alter distribution.
- Approval/rejection requires a current reviewer role and explicit review scope
  for the owner organization. A platform administrator is not automatically a
  reviewer. The requester may never review their own request.
- Yanking requires current owner organization administration or platform
  administration. It is irreversible, changes only `published` to `yanked`, and
  retains the immutable signature, snapshot, archive references and history.
- Reads require owner administration or assigned reviewer access. Review queues
  require assigned reviewer access. Unrelated organizations receive no private
  release/request metadata.
- Identity helpers revalidate authentic service-issued OIDC session objects and
  acquire database locks on session, user, membership, organization and scope
  records in the same business transaction. Cloned/forged principals and machine
  principals cannot call these human operations.
- Idempotency is actor-bound and payload-bound. Authorization is checked before
  replaying a committed result. Concurrent same-key retries produce one effect
  and one audit event; a different payload under the same key is rejected.

Request and approval both validate the full scope contract and require selected
organizations/deployments and their organizations to be active. They invoke
the shared `validateFrozenDependencies` with the **existing signed manifest's
exact release locks**, under transaction row locks. Every direct and transitive
dependency must still be published, identity/hash-compatible, and available to
the owner organization and every proposed recipient. No floating ref/version is
resolved. A change in a dependency's visibility or a dependency yank between
request and approval causes approval to fail without changing either record.

Scope narrowing is permitted even if another published release depends on this
release: it must be possible to revoke distribution. The download/catalog layer
must independently recheck the requesting identity against the current complete
fixed dependency graph; a prior download grant is not sufficient after a yank
or visibility revocation. This module does not delete already installed local
archives or stop a task already running from its frozen local snapshot.

Migration `005_governance.sql` adds request reasons and request state versions.
It freezes requested fields, forbids deletion/rewriting of decisions, and guards
distribution identity/version increments. All application scope changes go
through the review API; database-owner administrative SQL is not an API or an
authorization boundary.

## Reproducible component checks

From `apps/pack-center/`:

```sh
npm run build
node --test test/release-governance.test.mjs
npm run typecheck
```

The suite uses a uniquely labelled, loopback-only PostgreSQL 17 container and a
real local OIDC discovery/code/PKCE/token/JWKS flow. It tests independent review,
cross-organization/read isolation, live permission revocation, no-secret
metadata, strict detached input, same-key and competing concurrency, optimistic
versions, selected target disablement, direct/transitive dependency visibility,
dependency yanks, rejection, irreversible yanking and immutable signatures.
It seeds signed content fixtures to isolate governance; archive/Git/publication
and HTTP download behavior belong to their separate integration suites.

The fixture removes only its own validated container and anonymous test volume.
These are component checks, not browser UI, production-domain, two full Harness
deployment, or full goal acceptance evidence.
