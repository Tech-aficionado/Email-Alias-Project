# SPF/DKIM/DMARC Setup Guide

This guide ensures forwarded emails from GhostRelay don't land in spam.

## How It Works

> **Note:** alias forwarding no longer goes through Resend by default. Cloudflare's
> native `message.forward()` handles it for free and keeps SPF/DKIM alignment via
> ARC, so no DNS work is needed for that path — see
> [SETUP-FORWARDING.md](SETUP-FORWARDING.md).
>
> Follow this guide if you want the Resend fallback (for destinations Cloudflare
> hasn't verified) and transactional mail like password resets to authenticate
> properly.

Resend signs mail for the fallback path. When you verify your domain in Resend, they handle DKIM signing automatically. You just need to add the DNS records they provide.

## Step 1: Add Domain to Resend

1. Sign up at [resend.com](https://resend.com)
2. Go to **Domains** → **Add Domain**
3. Enter your domain: `ghostrelay.me` (or your custom domain)

## Step 2: Add DNS Records

Resend will give you records to add in Cloudflare DNS:

### SPF Record

| Type | Name | Content |
|------|------|---------|
| TXT  | @    | `v=spf1 include:send.resend.com ~all` |

> If you already have an SPF record, add `include:send.resend.com` before the `~all`.

### DKIM Records

Resend provides 3 CNAME records for DKIM. Add all of them:

| Type  | Name                          | Target (from Resend dashboard) |
|-------|-------------------------------|-------------------------------|
| CNAME | resend._domainkey             | (provided by Resend)          |
| CNAME | resend2._domainkey            | (provided by Resend)          |
| CNAME | resend3._domainkey            | (provided by Resend)          |

### DMARC Record

| Type | Name    | Content |
|------|---------|---------|
| TXT  | _dmarc  | `v=DMARC1; p=none; rua=mailto:dmarc@ghostrelay.me` |

> Start with `p=none` (monitoring only). Once you verify everything works, upgrade to `p=quarantine` or `p=reject`.

## Step 3: Verify in Resend

1. Go back to Resend → **Domains**
2. Click **Verify** on your domain
3. Wait for DNS propagation (usually 5–30 minutes)
4. Once verified, status will show ✓ for SPF, DKIM, and DMARC

## Step 4: Set API Key

```bash
cd worker
npx wrangler secret put RESEND_API_KEY
# Paste your Resend API key when prompted
```

## Step 5: Set Up Bounce Webhooks (Optional but Recommended)

1. In Resend → **Webhooks** → **Add Webhook**
2. Set endpoint URL: `https://your-worker.your-subdomain.workers.dev/api/webhooks/email-events`
3. Select events: `email.bounced`, `email.complained`, `email.delivery_delayed`
4. Copy the **signing secret** and add it:

```bash
npx wrangler secret put RESEND_WEBHOOK_SECRET
# Paste the webhook signing secret
```

## Verification

After setup, test deliverability:

1. Create a GhostRelay alias
2. Send an email to it from an external account (Gmail, Outlook)
3. Check the forwarded email headers for:
   - `dkim=pass`
   - `spf=pass`
   - `dmarc=pass`

In Gmail: Open the forwarded email → Click "⋮" → "Show original" → Check Authentication-Results.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| SPF failing | Ensure your SPF record includes `send.resend.com` |
| DKIM failing | Verify CNAME records are correct and propagated |
| Emails in spam | Check DMARC alignment; ensure "From" domain matches DKIM domain |
| Bounce webhook not working | Verify the endpoint URL is publicly accessible |

## DNS Propagation Check

Use these tools to verify your records:
- [MXToolbox SPF Lookup](https://mxtoolbox.com/spf.aspx)
- [Mail-Tester](https://www.mail-tester.com/) — send a test email for a score
- [DKIM Validator](https://dkimvalidator.com/)
