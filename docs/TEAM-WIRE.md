# Expert Teams wire API v1

The browser-facing team surface is deliberately smaller than `team.json` and
is JSON-safe. It never includes member prompts, mailbox contents, absolute
paths, provider credentials, or task output bodies.

`GET /plugins/dsh-expert-library/teams?captainSessionId=<session>&teamId=<id>`
returns `{version:1, team, plan, archived}`. `teamId` is optional when a
captain has one active team. It is required when more than one team is visible.
Before approval, a staged plan can be addressed with
`?captainSessionId=<session>&planId=<plan>`; this returns `team:null` and the
versioned `plan`, allowing the activity panel to edit or approve without a
materialized team.
The response projects plan digest/revision and approval receipt, member routes,
task dependencies and attempt ids, halt state, and quality-run review findings
with evidence counts and changed-path summaries.

Writes use the same URL with a JSON `POST` body:

```json
{
  "action": "edit | approve | discard | halt | resume | archive",
  "captainSessionId": "...",
  "teamId": "...",
  "planId": "...",
  "expectedDigest": "...",
  "expectedRevision": 2,
  "patch": {"goal": "..."},
  "reason": "..."
}
```

Plan edits and approvals must carry the displayed digest and revision; the
server delegates the compare-and-swap and ownership check to the existing plan
core. `halt`, `resume`, and `archive` also delegate to the durable state core.
The route does not acknowledge mail, kick members, or mutate a snapshot.

In DSH Web, both reads and writes first pass the native HostConnection browser
cookie/Host/Origin fence. Headless callers without that service use the
plugin's loopback/management-token fence. POST also requires a same-origin
`Origin` (or no Origin for non-browser local clients), a bounded body (128 KiB), and a fresh captain/session lookup. Errors
are fixed, redacted codes: `TEAM_UNAUTHORIZED`, `TEAM_CSRF_REJECTED`,
`TEAM_NOT_FOUND`, `TEAM_CAS_CONFLICT`, `TEAM_INVALID_INPUT`,
`TEAM_BODY_TOO_LARGE`, `TEAM_METHOD_NOT_ALLOWED`, or `TEAM_ACTION_FAILED`.
Unknown or cross-captain identifiers fail closed.

When mounted in DSH Web, the route first delegates to the native
`connection.requestRejection(request)` predicate. This verifies the signed
browser cookie and Host/Origin trust boundary (401/403); the plugin does not
interpret a captain session id as browser authentication. The literal
`Origin: null` is rejected. Durable GET projections remain available after a
DSH restart; mutations still require the live captain agent and the normal
state ownership checks.

`edit`, `approve`, and `discard` require the exact `planId`, `expectedDigest`,
and non-negative `expectedRevision`. The archive operation takes the team lock,
marks members removed, records the retired-session deny-list, waits for live
children to quiesce, and only then moves the team into the archive directory.

The TypeScript contract is in [`src/team-wire.ts`](../src/team-wire.ts) and the
HTTP adapter is [`src/host/team-routes.ts`](../src/host/team-routes.ts).
