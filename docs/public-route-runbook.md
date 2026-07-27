# Runbook — the public `/a/*` route on a shared hostname

## Symptom

Every server-hosted share link 404s. `attachments domain verify` exits 1 with:

```
FAIL: The attachment prefix is still being handled by the shortlinks app.
```

`attachments health-check` reports the affected links as `Dead (link 404)`.

## Cause

Server-hosted links are `https://<hostname>/a/<token>`. When that hostname
already has a generic `*` edge route pointed at a shortlinks/redirect service,
`/a/<token>` matches it and the shortlinks service answers — it has no such slug,
so it 404s. The attachments app never sees the request. Nothing inside the
attachments service can fix this: the request does not reach it.

Cloudflare selects the **most specific** matching route, so the remediation is a
`<hostname>/a/*` route bound to a worker that forwards to the attachments origin.
The generic `<hostname>/*` route can stay exactly as it is.

## Remediation

1. Record the origins (no credentials are stored, no DNS is mutated):

   ```bash
   attachments domain configure \
     --hostname <hostname> \
     --base-url https://<hostname> \
     --path-prefix /a \
     --provider cloudflare \
     --zone <dns-zone> \
     --attachments-origin https://<origin-that-runs-attachments-serve> \
     --fallback-origin https://<origin-that-serves-shortlinks>
   ```

   `--fallback-origin` is optional. Supply it only if you want this worker to own
   `<hostname>/*` as well; leave it out and only the `/a/*` route is claimed,
   which is the smaller change and leaves existing shortlinks traffic untouched.

2. Render the edge artifacts:

   ```bash
   attachments domain render --out ./edge
   ```

   This writes `edge/wrangler.toml` and `edge/worker.js`. The command **exits 1
   and writes nothing** if the attachments origin or public hostname is missing —
   a placeholder artifact deploys cleanly and leaves the prefix dead, which is
   how this outage stayed open.

3. Deploy the worker:

   ```bash
   cd edge && wrangler deploy
   ```

4. Gate on the probe. This must pass before the incident is closed:

   ```bash
   attachments domain verify --format json
   ```

   Exit 0 means the prefix reaches the attachments app. Exit 1 means it does not,
   or it does and the service answered 5xx — the probe deliberately fails a 5xx
   even though the app renders the same "Attachment unavailable" page it renders
   for an unknown token.

5. Re-check the links that were failing:

   ```bash
   attachments health-check
   ```

## Verification checklist

| Check | Command | Expected |
|---|---|---|
| Prefix reaches attachments | `attachments domain verify` | exit 0, `service: attachments` |
| Route order | `attachments domain render --format json` | `routes[0].pattern` is `<hostname>/a/*` |
| Links recovered | `attachments health-check` | no `Dead (link 404)` rows for `/a/` links |

## Rollback

Delete the `<hostname>/a/*` route (or `wrangler delete` the worker). Traffic
returns to the generic route — i.e. back to the 404 symptom above. The
attachments service itself is untouched by this change, so there is nothing to
roll back on the app side.
