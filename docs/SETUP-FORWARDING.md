# Mail Forwarding Setup

GhostRelay delivers alias mail through Cloudflare's native `message.forward()`.
Sends to verified destination addresses are [free and exempt from every quota and
daily sending limit](https://developers.cloudflare.com/email-service/platform/limits/),
on any plan. The ESP (Resend) is only a fallback.

## Why not send everything through an ESP

The worker already receives the full message via Email Routing. Re-sending it
through an ESP means paying quota to deliver mail Cloudflare will hand off for
nothing, and it forces you to re-sign as your own domain on behalf of a sender
you don't control. Resend's free tier is 100/day and 3,000/month, counted **per
recipient** — an alias with three destinations burns three units per email, so
the practical ceiling is well under 100 messages a day.

Self-hosting SMTP on a serverless platform is worse, not better: outbound port 25
is blocked on essentially every cloud host, you inherit a shared IP with no PTR
record you control, and there is no durable queue for the retries SMTP requires.
Forwarding relays arbitrary third-party content, which is the fastest way to
destroy a sending IP's reputation.

## Delivery order

1. **`message.forward()`** for destinations verified on the Cloudflare account.
   Free, unmetered, ARC-sealed. Runs first, while `message.raw` is untouched.
2. **Resend API** for anything left over — unverified destinations, or a
   `forward()` that failed. Metered.

If nothing is delivered, the worker distinguishes failure types:

- **Transient** (429 quota, 5xx, network): throws, producing a temporary SMTP
  failure so the sending server retries later.
- **Permanent** (400/422 rejections): `setReject()`, which bounces the message.

This matters. `setReject()` is a permanent refusal — using it for a rate limit
means the mail is gone rather than merely delayed.

## Setup

### 1. Apply the migration

```bash
npx wrangler d1 execute ghostrelay-db --remote --file=database/migration-cf-destinations.sql
```

This creates `cf_destinations`, the local cache of verification state. The email
hot path reads only from this table, so forwarding never waits on an API call.

### 2. Create an API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.

| Setting    | Value                                     |
|------------|-------------------------------------------|
| Permission | Account · Email Routing Addresses · Edit  |
| Resources  | Include · your account                    |

### 3. Set the secrets

```bash
cd worker
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler deploy
```

Both must be present or the worker skips native forwarding entirely and sends
everything through Resend.

### 4. Verify existing users' inboxes

New signups and newly added destinations register automatically. Addresses that
already existed before this change need a one-time backfill — have each user open
the dashboard, which calls `GET /api/destinations/status` and shows what's still
unverified, then `POST /api/destinations/verify` to trigger Cloudflare's email.

## Behaviour changes users will notice

`forward()` relays the original message rather than rebuilding it, so:

- The `From` header shows the real sender instead of `Sender via GhostRelay`.
  Better for deliverability, and the alias is still visible in `To`.
- The GhostRelay HTML footer is not appended.
- Only `X-` prefixed headers survive; `List-Unsubscribe` is dropped on this path.
- Subject prefixes on org mail (`[support] …`) only appear on the fallback path.

Bounce tracking still works. DSNs come back to the alias address and are handled
by `handleBounceNotification`; the Resend webhook continues to cover the fallback
path.

## Limits to plan around

| Limit                              | Value | Note                                    |
|------------------------------------|-------|-----------------------------------------|
| Verified destinations per account   | 200   | Raisable via Cloudflare's request form  |
| Routing rules per domain            | 200   | Not hit — the worker handles all routing |
| Inbound message size                | 25 MiB| Worker parses at most 256 KB of body     |

The 200-destination cap is the real ceiling on user growth for this path. Past
that, either request an increase or onboard a sending domain on Cloudflare Email
Service and use the `send_email` binding, which can reach any recipient.

## Verifying it works

After deploying, send a test email to an alias and check the worker logs:

```bash
npx wrangler tail
```

A free native delivery logs nothing on success. Look for these instead:

- `forward() to … failed` — destination is not verified; check the status endpoint.
- `Deferring mail for …` — transient failure, the sender will retry.
- `Resend 429` — fallback path hit its quota; verify the destination to stop
  routing through it.
