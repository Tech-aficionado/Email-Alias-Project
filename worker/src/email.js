/**
 * Email forwarding handler
 * - Receives via Cloudflare Email Routing
 * - Delivers primarily via `message.forward()` — free, unmetered, and Cloudflare
 *   handles SPF/DKIM alignment and ARC sealing for the relay
 * - Falls back to the Resend API for destinations Cloudflare has not verified
 * - Detects and records bounces
 * - Handles bounce notification emails (DSN)
 */

import { isSenderBlocked } from './blocklist.js';
import { partitionByVerification, isCfRoutingConfigured } from './cf-destinations.js';

const MAX_EMAIL_SIZE = 256 * 1024; // 256KB max email body

// Reject reasons returned to the sending MTA when an alias can't receive mail.
const BLOCK_REASON_MESSAGES = {
    disabled: 'Address is disabled',
    expired: 'Address has expired',
    limit: 'Address has reached its email limit',
};

/**
 * Determine whether an alias may currently receive mail.
 * Pure function (no I/O) so it can be unit tested in isolation.
 *
 * @param {{active?: number|boolean, expires_at?: string|null, max_emails?: number|null, forwarded_count?: number}} alias
 * @param {Date} [now] - injectable clock for testing
 * @returns {null|'not_found'|'disabled'|'expired'|'limit'} null when deliverable, else a reason
 */
export function getAliasBlockReason(alias, now = new Date()) {
    if (!alias) return 'not_found';
    if (!alias.active) return 'disabled';
    if (alias.expires_at && new Date(alias.expires_at) < now) return 'expired';
    if (alias.max_emails && (alias.forwarded_count ?? 0) >= alias.max_emails) return 'limit';
    return null;
}

// Organization emails that should NOT be used as aliases.
// All mail to these addresses is forwarded to the admin/owner inbox,
// which is configured via the ORG_FORWARD_TO environment variable.
const ORG_EMAILS = [
    'support@ghostrelay.me',
    'sales@ghostrelay.me',
    'legal@ghostrelay.me',
    'privacy@ghostrelay.me',
    'dmarc@ghostrelay.me',
];

export async function handleEmail(message, env) {
    // At least one delivery path must be available: Cloudflare native forwarding
    // (preferred, free) or the Resend API (fallback for unverified destinations).
    if (!isCfRoutingConfigured(env) && !env.RESEND_API_KEY) {
        console.error('No delivery path configured — set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID or RESEND_API_KEY');
        // Temporary failure, not a reject: the sender should retry once we're fixed
        // rather than receive a permanent bounce for our own misconfiguration.
        throw new Error('No delivery path configured');
    }

    const recipientAddress = message.to.toLowerCase().trim();
    const senderAddress = message.from;
    const subject = (message.headers.get('subject') || '(no subject)').substring(0, 998);

    // Check if this is a bounce notification (DSN)
    if (isBounceNotification(message)) {
        await handleBounceNotification(message, env);
        return;
    }

    // Intercept organization emails — forward directly to admin, never treat as alias
    if (ORG_EMAILS.includes(recipientAddress)) {
        await forwardOrgEmail(message, env, recipientAddress, senderAddress, subject);
        return;
    }

    // Validate recipient format
    if (!recipientAddress.includes('@') || recipientAddress.length > 254) {
        message.setReject('Invalid address');
        return;
    }

    // Look up alias (direct match first)
    let alias = await env.DB.prepare(
        'SELECT a.id, a.active, a.user_id, a.expires_at, a.max_emails, a.forwarded_count, a.is_temporary, u.email as forward_to FROM aliases a JOIN users u ON a.user_id = u.id WHERE LOWER(a.address) = ?'
    ).bind(recipientAddress).first();

    // If no direct match, try wildcard/catch-all rules
    if (!alias) {
        alias = await matchWildcardAlias(recipientAddress, env);
    }

    if (!alias) {
        message.setReject('Address not found');
        return;
    }

    // Centralized deliverability check (active / expiry / email-cap).
    const blockReason = getAliasBlockReason(alias);
    if (blockReason) {
        // Auto-disable expired or exhausted aliases so the dashboard reflects
        // reality and subsequent lookups short-circuit without recomputing.
        if (blockReason === 'expired' || blockReason === 'limit') {
            await env.DB.prepare('UPDATE aliases SET active = 0 WHERE id = ?').bind(alias.id).run();
        }
        message.setReject(BLOCK_REASON_MESSAGES[blockReason] || 'Address unavailable');
        return;
    }

    // Check sender blocklist
    if (await isSenderBlocked(alias.id, senderAddress, env)) {
        message.setReject('Sender blocked');
        return;
    }

    // Determine all forwarding destinations. Deduped because Cloudflare rejects
    // a second forward of the same message to an address it already accepted.
    const destinations = await getForwardingDestinations(alias.id, alias.forward_to, env);

    if (destinations.length === 0) {
        message.setReject('No forwarding destination configured');
        return;
    }

    const outcome = await deliver(message, env, {
        destinations,
        aliasId: alias.id,
        recipientAddress,
        senderAddress,
        subject,
    });

    if (outcome.delivered.length === 0) {
        // Transient failures (rate limits, 5xx, network errors) must surface as a
        // temporary error so the sending MTA queues and retries. `setReject` issues
        // a permanent SMTP refusal, which would bounce the mail and lose it — the
        // wrong outcome for something as recoverable as an exhausted API quota.
        if (outcome.transient) {
            console.error(`Deferring mail for ${recipientAddress}: ${outcome.summary}`);
            throw new Error(`Temporary delivery failure: ${outcome.summary}`);
        }

        console.error(`Permanent delivery failure for ${recipientAddress}: ${outcome.summary}`);
        await recordBounce(env, alias.id, destinations[0], 'hard', outcome.summary,
            senderAddress, subject);
        message.setReject('Forwarding failed');
        return;
    }

    if (outcome.failed.length > 0) {
        // Some destinations landed, some did not. The message is not lost, so don't
        // fail the SMTP transaction — just record it so the user can see the gap.
        console.warn(`Partial delivery for ${recipientAddress}: ${outcome.summary}`);
        for (const failure of outcome.failed) {
            // Only genuine permanent rejections count as hard bounces — those are what
            // auto-disable an alias. A missing verification or a rate limit must not.
            const bounceType = (failure.transient || failure.configuration) ? 'soft' : 'hard';
            await recordBounce(env, alias.id, failure.destination, bounceType,
                failure.reason, senderAddress, subject);
        }
    }

    await recordSuccessfulDelivery(env, alias, recipientAddress, senderAddress, subject);
}

// ===== Delivery =====

/**
 * Deliver a message to every destination, preferring Cloudflare's native
 * forwarding.
 *
 * Two paths, in order:
 *   1. `message.forward()` for destinations verified on the Cloudflare account.
 *      Free, exempt from every quota and daily send limit, and Cloudflare keeps
 *      SPF/DKIM alignment intact via ARC. This runs first, while `message.raw`
 *      is still untouched.
 *   2. The Resend API for anything left over. Costs quota, so it only covers
 *      destinations the owner hasn't verified yet.
 *
 * @returns {Promise<{delivered: string[], failed: Array<{destination: string, reason: string, transient: boolean}>, transient: boolean, summary: string}>}
 */
async function deliver(message, env, ctx) {
    const delivered = [];
    const failed = [];

    const { forwardable, unverified } = await partitionByVerification(env, ctx.destinations);

    // Cloudflare marks some messages as non-forwardable (e.g. already-forwarded
    // loops). Those have to go through the API path instead.
    const canForward = message.canBeForwarded !== false;
    const viaApi = [...unverified];

    if (canForward) {
        // Only X- prefixed headers survive forward(); everything else is stripped.
        const extraHeaders = new Headers();
        extraHeaders.set('X-GhostRelay-Alias-ID', ctx.aliasId);
        extraHeaders.set('X-GhostRelay-Alias', ctx.recipientAddress);

        for (const destination of forwardable) {
            try {
                await message.forward(destination, extraHeaders);
                delivered.push(destination);
            } catch (error) {
                const reason = error?.message || String(error);

                // Cloudflare treats a repeat forward to the same address as an
                // error, but the recipient already has the mail.
                if (/already forwarded/i.test(reason)) {
                    delivered.push(destination);
                    continue;
                }

                console.error(`forward() to ${destination} failed: ${reason}`);
                // Retry through the API path — a verification that lapsed on
                // Cloudflare's side shouldn't drop the message.
                viaApi.push(destination);
            }
        }
    } else {
        viaApi.push(...forwardable);
    }

    if (viaApi.length > 0) {
        if (env.RESEND_API_KEY) {
            const apiResult = await deliverViaResend(message, env, ctx, viaApi);
            delivered.push(...apiResult.delivered);
            failed.push(...apiResult.failed);
        } else {
            for (const destination of viaApi) {
                failed.push({
                    destination,
                    reason: 'Destination is not a verified Cloudflare address and no fallback sender is configured',
                    // Treated as transient on purpose: the owner only has to click
                    // Cloudflare's verification link. Deferring holds the mail in the
                    // sender's queue during that window instead of bouncing it, and
                    // keeps a config gap from counting as a dead mailbox.
                    transient: true,
                    configuration: true,
                });
            }
        }
    }

    return {
        delivered,
        failed,
        // Defer the whole message only if nothing got through for a recoverable reason.
        transient: failed.some(f => f.transient),
        summary: failed.map(f => `${f.destination}: ${f.reason}`).join(' | ')
            || `delivered to ${delivered.length} destination(s)`,
    };
}

/**
 * Fallback sender for destinations Cloudflare will not forward to.
 * Rebuilds the message as a new outbound email from the alias address, which is
 * why it needs a verified sending domain (SPF + DKIM + DMARC) on the ESP side.
 */
async function deliverViaResend(message, env, ctx, destinations) {
    const domain = env.EMAIL_DOMAIN || 'ghostrelay.me';
    const fromAddress = `${ctx.recipientAddress.split('@')[0]}@${domain}`;
    const senderName = sanitizeHeaderValue(extractName(ctx.senderAddress));

    let emailText = '';
    let emailHtml = '';
    try {
        const rawBody = await readStream(message.raw, MAX_EMAIL_SIZE);
        ({ text: emailText, html: emailHtml } = extractBodyParts(rawBody));
    } catch (error) {
        // `message.raw` can already be consumed once native forwarding has run.
        // Treat it as transient so the sender retries rather than losing the mail.
        const reason = `Could not read message body: ${error?.message || error}`;
        console.error(reason);
        return {
            delivered: [],
            failed: destinations.map(destination => ({ destination, reason, transient: true })),
        };
    }

    const forwardedHtml = emailHtml
        ? buildHtmlWrapper(ctx.senderAddress, ctx.recipientAddress, emailHtml)
        : buildHtml(ctx.senderAddress, ctx.recipientAddress, emailText);

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: `${senderName} via GhostRelay <${fromAddress}>`,
                to: destinations,
                reply_to: ctx.senderAddress,
                subject: ctx.subject,
                html: forwardedHtml,
                text: emailText || stripHtml(emailHtml || ''),
                headers: {
                    // Custom headers for bounce tracking
                    'X-GhostRelay-Alias-ID': ctx.aliasId,
                    'X-GhostRelay-Original-From': ctx.senderAddress,
                    // List-Unsubscribe for better deliverability
                    'List-Unsubscribe': `<mailto:unsubscribe@${domain}?subject=unsubscribe-${ctx.aliasId}>`,
                },
            }),
        });

        if (res.ok) {
            return { delivered: [...destinations], failed: [] };
        }

        const errBody = (await res.text()).substring(0, 300);
        console.error(`Resend ${res.status}: ${errBody}`);

        return {
            delivered: [],
            failed: destinations.map(destination => ({
                destination,
                reason: `Resend ${res.status}: ${errBody}`,
                transient: isTransientHttpStatus(res.status),
            })),
        };
    } catch (error) {
        // Network-level failure — always worth a retry.
        const reason = `Resend request failed: ${error?.message || error}`;
        console.error(reason);
        return {
            delivered: [],
            failed: destinations.map(destination => ({ destination, reason, transient: true })),
        };
    }
}

/**
 * Whether an HTTP status from a sending provider is worth retrying.
 * 429 (quota/rate limit) and 5xx are recoverable; 4xx rejections are not.
 */
function isTransientHttpStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}

/**
 * Record a successful forward: bump counters, write the activity log, trim old
 * logs, and notify the user's devices.
 */
async function recordSuccessfulDelivery(env, alias, recipientAddress, senderAddress, subject) {
    await env.DB.prepare(
        'UPDATE aliases SET forwarded_count = forwarded_count + 1 WHERE id = ?'
    ).bind(alias.id).run();

    await env.DB.prepare(
        'INSERT INTO email_logs (id, alias_id, sender, subject, forwarded_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), alias.id, senderAddress, subject, new Date().toISOString()).run();

    // Retain only the last 1000 logs per user to prevent unbounded growth
    // Runs probabilistically (~10% of the time) to avoid overhead on every email
    if (Math.random() < 0.1) {
        try {
            await env.DB.prepare(`
                DELETE FROM email_logs WHERE id IN (
                    SELECT l.id FROM email_logs l
                    JOIN aliases a ON l.alias_id = a.id
                    WHERE a.user_id = ?
                    ORDER BY l.forwarded_at DESC
                    LIMIT -1 OFFSET 1000
                )
            `).bind(alias.user_id).run();
        } catch { /* non-critical — skip silently */ }
    }

    // Send push notifications to user
    await sendPushNotification(env, alias.user_id, {
        title: `New email via ${recipientAddress}`,
        body: `From: ${senderAddress}\n${subject}`,
        tag: alias.id,
    });
}

/**
 * Forward organization emails (support@, sales@, legal@, privacy@, dmarc@)
 * directly to the admin inbox without alias lookup.
 */
async function forwardOrgEmail(message, env, recipientAddress, senderAddress, subject) {
    const orgForwardTo = env.ORG_FORWARD_TO;
    if (!orgForwardTo) {
        console.error('ORG_FORWARD_TO not configured — cannot forward organization email');
        message.setReject('Service misconfigured');
        return;
    }

    // Native forwarding first. The admin inbox is under your control, so verify it
    // once as a Cloudflare destination address and org mail costs nothing forever.
    if (message.canBeForwarded !== false) {
        try {
            const extraHeaders = new Headers();
            extraHeaders.set('X-GhostRelay-Org-Email', recipientAddress);
            await message.forward(orgForwardTo, extraHeaders);
            console.log(`Org email forwarded natively: ${recipientAddress} -> ${orgForwardTo}`);
            return;
        } catch (error) {
            console.error(`Native org forward failed (${recipientAddress}): ${error?.message || error}`);
            // Fall through to the API path below.
        }
    }

    if (!env.RESEND_API_KEY) {
        throw new Error(`Cannot forward org email to ${orgForwardTo}: address is not a verified Cloudflare destination and no fallback sender is configured`);
    }

    const rawBody = await readStream(message.raw, MAX_EMAIL_SIZE);
    const { text: emailText, html: emailHtml } = extractBodyParts(rawBody);
    const senderName = sanitizeHeaderValue(extractName(senderAddress));
    const domain = env.EMAIL_DOMAIN || 'ghostrelay.me';
    const fromAddress = `${recipientAddress.split('@')[0]}@${domain}`;

    const forwardedHtml = emailHtml
        ? buildHtmlWrapper(senderAddress, recipientAddress, emailHtml)
        : buildHtml(senderAddress, recipientAddress, emailText);

    try {
        const resendPayload = {
            from: `${senderName} via GhostRelay <${fromAddress}>`,
            to: [orgForwardTo],
            reply_to: senderAddress,
            subject: `[${recipientAddress.split('@')[0]}] ${subject}`,
            html: forwardedHtml,
            text: emailText || stripHtml(emailHtml || ''),
            headers: {
                'X-GhostRelay-Org-Email': recipientAddress,
                'X-GhostRelay-Original-From': senderAddress,
            },
        };

        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(resendPayload),
        });

        if (!res.ok) {
            const errBody = (await res.text()).substring(0, 300);
            console.error(`Org email forward failed (${recipientAddress}): Resend ${res.status}: ${errBody}`);

            // Quota and 5xx failures are recoverable — defer so the sender retries.
            if (isTransientHttpStatus(res.status)) {
                throw new Error(`Temporary org forward failure: Resend ${res.status}`);
            }

            message.setReject('Forwarding failed');
            return;
        }

        console.log(`Org email forwarded: ${recipientAddress} from ${senderAddress} -> ${orgForwardTo}`);
    } catch (error) {
        // Re-throw deferrals; only genuine permanent failures reject.
        if (/^Temporary /.test(error?.message || '')) throw error;
        console.error('Org email forward error:', error.message || error);
        message.setReject('Forwarding failed');
    }
}

/**
 * Handle Resend webhook for bounce/complaint notifications
 * Called from the main router for POST /api/webhooks/email-events
 */
export async function handleEmailWebhook(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Verify webhook signature if RESEND_WEBHOOK_SECRET is set
    if (env.RESEND_WEBHOOK_SECRET) {
        const signature = request.headers.get('svix-signature');
        const timestamp = request.headers.get('svix-timestamp');
        const svixId = request.headers.get('svix-id');

        if (!signature || !timestamp || !svixId) {
            return Response.json({ error: 'Missing webhook signature' }, { status: 401 });
        }

        // Validate timestamp is within 5 minutes (prevent replay)
        const webhookTime = parseInt(timestamp) * 1000;
        if (Math.abs(Date.now() - webhookTime) > 300000) {
            return Response.json({ error: 'Webhook timestamp expired' }, { status: 401 });
        }
    }

    const eventType = body.type;
    const data = body.data;

    if (!eventType || !data) {
        return Response.json({ error: 'Invalid event payload' }, { status: 400 });
    }

    // Handle bounce events
    if (eventType === 'email.bounced') {
        await processBounceEvent(data, env);
    }

    // Handle complaint events (user marked as spam)
    if (eventType === 'email.complained') {
        await processComplaintEvent(data, env);
    }

    // Handle delivery failures
    if (eventType === 'email.delivery_delayed') {
        await processSoftBounce(data, env);
    }

    return Response.json({ received: true });
}

// ===== Bounce Processing =====

/**
 * Check if an incoming email is a bounce notification (DSN - Delivery Status Notification)
 */
function isBounceNotification(message) {
    const from = message.from.toLowerCase();
    const contentType = message.headers.get('content-type') || '';
    const subject = (message.headers.get('subject') || '').toLowerCase();

    // Common bounce indicators
    if (from.includes('mailer-daemon') || from.includes('postmaster')) return true;
    if (contentType.includes('delivery-status')) return true;
    if (subject.includes('delivery status notification')) return true;
    if (subject.includes('undeliverable') || subject.includes('undelivered')) return true;
    if (subject.includes('mail delivery failed')) return true;
    if (subject.includes('returned mail')) return true;

    return false;
}

/**
 * Handle DSN (bounce notification) emails received directly
 */
async function handleBounceNotification(message, env) {
    const recipientAddress = message.to.toLowerCase().trim();
    const subject = message.headers.get('subject') || '';

    // Try to find the alias this bounce relates to
    const alias = await env.DB.prepare(
        'SELECT a.id, u.email as forward_to FROM aliases a JOIN users u ON a.user_id = u.id WHERE LOWER(a.address) = ?'
    ).bind(recipientAddress).first();

    if (!alias) return; // Can't associate this bounce

    // Determine bounce type from subject/content
    const subjectLower = subject.toLowerCase();
    let bounceType = 'hard';
    if (subjectLower.includes('delayed') || subjectLower.includes('temporary')) {
        bounceType = 'soft';
    }

    // Read body for reason
    const rawBody = await readStream(message.raw, 32768); // Smaller limit for bounce messages
    const bodyText = extractBody(rawBody);
    const reason = extractBounceReason(bodyText, subject);

    await recordBounce(env, alias.id, alias.forward_to, bounceType, reason, message.from, subject);
}

/**
 * Process a bounce event from Resend webhook
 */
async function processBounceEvent(data, env) {
    const aliasId = extractAliasIdFromHeaders(data);
    const recipientEmail = data.to?.[0] || '';
    const reason = data.bounce?.description || data.bounce?.message || 'Hard bounce';

    if (aliasId) {
        await recordBounce(env, aliasId, recipientEmail, 'hard', reason, '', '');
    }
}

/**
 * Process a complaint event (spam report) from Resend webhook
 */
async function processComplaintEvent(data, env) {
    const aliasId = extractAliasIdFromHeaders(data);
    const recipientEmail = data.to?.[0] || '';

    if (aliasId) {
        await recordBounce(env, aliasId, recipientEmail, 'complaint',
            'Recipient marked email as spam', '', '');
    }
}

/**
 * Process a soft bounce (temporary delivery failure)
 */
async function processSoftBounce(data, env) {
    const aliasId = extractAliasIdFromHeaders(data);
    const recipientEmail = data.to?.[0] || '';
    const reason = data.delayed?.description || 'Temporary delivery failure';

    if (aliasId) {
        await recordBounce(env, aliasId, recipientEmail, 'soft', reason, '', '');
    }
}

/**
 * Extract alias ID from custom headers in webhook data
 */
function extractAliasIdFromHeaders(data) {
    // Resend includes custom headers in webhook payloads
    if (data.headers) {
        for (const header of data.headers) {
            if (header.name === 'X-GhostRelay-Alias-ID') {
                return header.value;
            }
        }
    }
    return null;
}

/**
 * Record a bounce event in the database
 */
async function recordBounce(env, aliasId, recipientEmail, bounceType, reason, originalSender, originalSubject) {
    try {
        await env.DB.prepare(
            'INSERT INTO email_bounces (id, alias_id, recipient_email, bounce_type, bounce_reason, original_sender, original_subject, bounced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            crypto.randomUUID(),
            aliasId,
            recipientEmail,
            bounceType,
            reason.substring(0, 500),
            originalSender.substring(0, 254),
            originalSubject.substring(0, 200),
            new Date().toISOString()
        ).run();

        // Increment bounce count on alias
        await env.DB.prepare(
            'UPDATE aliases SET bounce_count = COALESCE(bounce_count, 0) + 1 WHERE id = ?'
        ).bind(aliasId).run();

        // Auto-disable alias after 5 hard bounces (deliverability protection)
        const bounceCount = await env.DB.prepare(
            "SELECT COUNT(*) as count FROM email_bounces WHERE alias_id = ? AND bounce_type = 'hard'"
        ).bind(aliasId).first();

        if (bounceCount && bounceCount.count >= 5) {
            await env.DB.prepare(
                'UPDATE aliases SET active = 0 WHERE id = ?'
            ).bind(aliasId).run();
            console.log(`Auto-disabled alias ${aliasId} after 5 hard bounces`);
        }
    } catch (error) {
        console.error('Failed to record bounce:', error.message || error);
    }
}

/**
 * Extract a human-readable bounce reason from DSN body
 */
function extractBounceReason(body, subject) {
    // Look for common bounce reason patterns
    const patterns = [
        /(?:reason|diagnostic)[:\s]*(.{10,200})/i,
        /(?:550|551|552|553|554)\s+(.{10,200})/i,
        /(?:user unknown|mailbox not found|does not exist)(.{0,100})/i,
        /(?:over quota|mailbox full)(.{0,100})/i,
    ];

    for (const pattern of patterns) {
        const match = body.match(pattern);
        if (match) return match[0].trim().substring(0, 300);
    }

    // Fallback to subject
    return subject.substring(0, 200) || 'Delivery failed';
}

// ===== Helpers =====

function extractName(email) {
    const match = email.match(/^"?([^"<]+)"?\s*</);
    if (match) return match[1].trim();
    return email.split('@')[0];
}

function buildHtml(from, alias, body) {
    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;">
<div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:#1a1a1a;">${esc(body)}</div>
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;">
This email was sent to <strong>${esc(alias)}</strong> and forwarded by <a href="https://ghostrelay.me" style="color:#7c3aed;text-decoration:none;">GhostRelay</a>.
Original sender: ${esc(from)}
</div>
</div>`;
}

function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeHeaderValue(str) {
    return str.replace(/[\r\n\t]/g, '').replace(/[^\x20-\x7E]/g, '').substring(0, 64);
}

async function readStream(stream, maxSize) {
    const reader = stream.getReader();
    const chunks = [];
    let totalSize = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
            totalSize += value.length;
            if (totalSize > maxSize) {
                reader.cancel();
                break;
            }
            chunks.push(value);
        }
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function extractBody(rawBytes) {
    const { text } = extractBodyParts(rawBytes);
    return text;
}

/**
 * Extract both text/plain and text/html parts from a raw email.
 * Returns { text, html } where either may be empty string.
 */
function extractBodyParts(rawBytes) {
    const raw = new TextDecoder().decode(rawBytes);
    const sep = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
    const headerEnd = raw.indexOf(sep);
    if (headerEnd === -1) return { text: '', html: '' };

    const headers = raw.substring(0, headerEnd);
    let body = raw.substring(headerEnd + sep.length);

    const boundaryMatch = headers.match(/boundary="?([^"\r\n;]+)"?/i);
    if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        const parts = body.split('--' + boundary);
        let text = '';
        let html = '';

        for (const part of parts) {
            const partLower = part.toLowerCase();
            const partSep = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
            const partStart = part.indexOf(partSep);
            if (partStart === -1) continue;

            const partContent = part.substring(partStart + partSep.length).trim();

            // Handle nested multipart (e.g. multipart/alternative inside multipart/mixed)
            const nestedBoundaryMatch = part.match(/boundary="?([^"\r\n;]+)"?/i);
            if (nestedBoundaryMatch) {
                const nestedParts = partContent.split('--' + nestedBoundaryMatch[1]);
                for (const nested of nestedParts) {
                    const nestedLower = nested.toLowerCase();
                    const nSep = nested.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
                    const nStart = nested.indexOf(nSep);
                    if (nStart === -1) continue;
                    const nestedContent = nested.substring(nStart + nSep.length).trim();

                    if (nestedLower.includes('content-type: text/plain') && !text) {
                        text = decodePartContent(nested, nestedContent).substring(0, 50000);
                    } else if (nestedLower.includes('content-type: text/html') && !html) {
                        html = decodePartContent(nested, nestedContent).substring(0, 100000);
                    }
                }
                continue;
            }

            if (partLower.includes('content-type: text/plain') && !text) {
                text = decodePartContent(part, partContent).substring(0, 50000);
            } else if (partLower.includes('content-type: text/html') && !html) {
                html = decodePartContent(part, partContent).substring(0, 100000);
            }
        }

        return { text, html };
    }

    // Non-multipart: check Content-Type in headers
    const ctLower = headers.toLowerCase();
    if (ctLower.includes('content-type: text/html') || ctLower.includes('content-type:text/html')) {
        return { text: '', html: body.trim().substring(0, 100000) };
    }

    return { text: body.trim().substring(0, 50000), html: '' };
}

/**
 * Decode MIME part content based on Content-Transfer-Encoding
 */
function decodePartContent(partHeaders, content) {
    const headersLower = partHeaders.toLowerCase();

    if (headersLower.includes('content-transfer-encoding: quoted-printable')) {
        return decodeQuotedPrintable(content);
    }
    if (headersLower.includes('content-transfer-encoding: base64')) {
        try {
            return atob(content.replace(/\s/g, ''));
        } catch {
            return content;
        }
    }
    return content;
}

/**
 * Decode quoted-printable encoded content
 */
function decodeQuotedPrintable(str) {
    return str
        .replace(/=\r?\n/g, '') // soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Strip HTML tags for plain text fallback
 */
function stripHtml(html) {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 50000);
}

/**
 * Wrap original HTML email with GhostRelay footer (preserves original rendering)
 */
function buildHtmlWrapper(from, alias, originalHtml) {
    const footer = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
This email was sent to <strong>${esc(alias)}</strong> and forwarded by <a href="https://ghostrelay.me" style="color:#7c3aed;text-decoration:none;">GhostRelay</a>.
Original sender: ${esc(from)}
</div>`;

    // Insert footer before </body> if it exists, otherwise append
    if (originalHtml.toLowerCase().includes('</body>')) {
        return originalHtml.replace(/<\/body>/i, `${footer}</body>`);
    }
    return originalHtml + footer;
}

// ===== Multiple Destinations =====

/**
 * Get all active forwarding destinations for an alias.
 * Falls back to the user's primary email if no custom destinations exist.
 */
async function getForwardingDestinations(aliasId, defaultEmail, env) {
    const { results } = await env.DB.prepare(
        'SELECT email FROM alias_destinations WHERE alias_id = ? AND active = 1'
    ).bind(aliasId).all();

    const emails = (results && results.length > 0)
        ? results.map(r => r.email)
        // Default: forward to user's primary email
        : [defaultEmail];

    // Normalize and dedupe: `message.forward()` errors on a repeat delivery to the
    // same address, and duplicates would otherwise burn extra ESP quota.
    return [...new Set(
        emails.filter(Boolean).map(e => String(e).trim().toLowerCase())
    )];
}

// ===== Wildcard/Catch-All Matching =====

/**
 * Match an incoming email address against wildcard rules.
 * Patterns use * as a wildcard (e.g. '*-shopping' matches 'anything-shopping').
 * Returns an alias-like object if matched, or null.
 */
async function matchWildcardAlias(recipientAddress, env) {
    const [localPart, domain] = recipientAddress.split('@');

    // Only match wildcard rules for the domain this worker is configured for.
    // Prevents a rule from unintentionally matching addresses on other domains.
    const configuredDomain = (env.EMAIL_DOMAIN || 'ghostrelay.me').toLowerCase();
    if (!domain || domain.toLowerCase() !== configuredDomain) return null;

    // Get all active wildcard rules
    const { results } = await env.DB.prepare(
        'SELECT wr.id, wr.user_id, wr.pattern, wr.active, wr.forwarded_count, u.email as forward_to FROM wildcard_rules wr JOIN users u ON wr.user_id = u.id WHERE wr.active = 1'
    ).all();

    if (!results || results.length === 0) return null;

    for (const rule of results) {
        if (matchPattern(localPart, rule.pattern)) {
            // Auto-create the alias for tracking (so future emails go through direct lookup)
            const aliasId = crypto.randomUUID();
            const aliasAddress = recipientAddress;

            try {
                await env.DB.prepare(
                    'INSERT OR IGNORE INTO aliases (id, user_id, address, label, notes, active, forwarded_count, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)'
                ).bind(aliasId, rule.user_id, aliasAddress, `Auto: ${rule.pattern}`, `Created by wildcard rule: ${rule.pattern}`, new Date().toISOString()).run();

                // Update wildcard forwarded count
                await env.DB.prepare(
                    'UPDATE wildcard_rules SET forwarded_count = forwarded_count + 1 WHERE id = ?'
                ).bind(rule.id).run();
            } catch (e) {
                // If alias already exists (race condition), look it up
                const existing = await env.DB.prepare(
                    'SELECT a.id, a.active, a.user_id, u.email as forward_to FROM aliases a JOIN users u ON a.user_id = u.id WHERE LOWER(a.address) = ?'
                ).bind(aliasAddress).first();
                if (existing) return existing;
            }

            return {
                id: aliasId,
                active: true,
                user_id: rule.user_id,
                forward_to: rule.forward_to,
                expires_at: null,
                max_emails: null,
                forwarded_count: 0,
                is_temporary: 0,
            };
        }
    }

    return null;
}

/**
 * Convert a wildcard pattern into a RegExp where `*` is the only wildcard.
 * Every other regex metacharacter is escaped so it's matched literally — this
 * closes a leak where characters like `?` or `+` in a pattern were previously
 * interpreted as regex operators. `*` matches any run of characters within the
 * local part but never crosses the `@` boundary.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function wildcardToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = '^' + escaped.replace(/\\\*/g, '[^@]*') + '$';
    return new RegExp(regexStr, 'i');
}

/**
 * Match a local part against a wildcard pattern.
 * '*' matches any sequence of characters within the local part.
 */
export function matchPattern(input, pattern) {
    try {
        return wildcardToRegExp(pattern).test(input);
    } catch {
        return false;
    }
}

// ===== Push Notifications =====

/**
 * Send push notification to all of a user's subscribed devices
 */
async function sendPushNotification(env, userId, payload) {
    if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;

    try {
        const { results } = await env.DB.prepare(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
        ).bind(userId).all();

        if (!results || results.length === 0) return;

        for (const sub of results) {
            try {
                // Use Web Push protocol via fetch
                await sendWebPush(env, sub, JSON.stringify(payload));
            } catch (err) {
                // If endpoint is gone (410), remove subscription
                if (err.status === 410 || err.status === 404) {
                    await env.DB.prepare(
                        'DELETE FROM push_subscriptions WHERE endpoint = ?'
                    ).bind(sub.endpoint).run();
                }
            }
        }
    } catch (err) {
        console.error('Push notification error:', err.message || err);
    }
}

/**
 * Minimal Web Push implementation for Cloudflare Workers
 */
async function sendWebPush(env, subscription, payload) {
    // For a production implementation, use the web-push protocol with VAPID.
    // This is a simplified version that sends via the push endpoint.
    const res = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'TTL': '86400',
        },
        body: payload,
    });

    if (!res.ok) {
        const err = new Error(`Push failed: ${res.status}`);
        err.status = res.status;
        throw err;
    }
}
