/**
 * Multiple Forwarding Destinations handler
 * Allows an alias to forward to multiple email addresses (team use case)
 */

import { authenticateRequest } from './auth.js';
import {
    ensureCfDestination,
    getCachedDestinationStates,
    getOwnedDestinations,
    isCfRoutingConfigured,
    syncCfDestinations,
} from './cf-destinations.js';

const MAX_DESTINATIONS_PER_ALIAS = 5;
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export async function handleDestinations(request, env, path) {
    const userId = await authenticateRequest(request, env);
    if (!userId) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const method = request.method;

    // GET /api/aliases/:aliasId/destinations
    const listMatch = path.match(/^\/api\/aliases\/([a-f0-9-]+)\/destinations$/i);
    if (method === 'GET' && listMatch) {
        return listDestinations(userId, listMatch[1], env);
    }

    // POST /api/aliases/:aliasId/destinations
    if (method === 'POST' && listMatch) {
        return addDestination(request, userId, listMatch[1], env);
    }

    // DELETE /api/aliases/:aliasId/destinations/:destId
    const deleteMatch = path.match(/^\/api\/aliases\/([a-f0-9-]+)\/destinations\/([a-f0-9-]+)$/i);
    if (method === 'DELETE' && deleteMatch) {
        return removeDestination(userId, deleteMatch[1], deleteMatch[2], env);
    }

    // PATCH /api/aliases/:aliasId/destinations/:destId
    const patchMatch = path.match(/^\/api\/aliases\/([a-f0-9-]+)\/destinations\/([a-f0-9-]+)$/i);
    if (method === 'PATCH' && patchMatch) {
        return toggleDestination(request, userId, patchMatch[1], patchMatch[2], env);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
}

// ===== Cloudflare destination verification =====

/**
 * Routes:
 *   GET  /api/destinations/status   — verification state of every inbox this user forwards to
 *   POST /api/destinations/verify   — register / re-send verification for an owned inbox
 *
 * Verified addresses are delivered to by free native forwarding; unverified ones
 * fall through to the metered ESP, so this state is worth surfacing prominently.
 */
export async function handleDestinationVerification(request, env, path) {
    const userId = await authenticateRequest(request, env);
    if (!userId) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isCfRoutingConfigured(env)) {
        return Response.json({
            error: 'Cloudflare destination verification is not configured on this deployment',
        }, { status: 501 });
    }

    if (request.method === 'GET' && path === '/api/destinations/status') {
        return getVerificationStatus(userId, env);
    }

    if (request.method === 'POST' && path === '/api/destinations/verify') {
        return requestVerification(request, userId, env);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
}

async function getVerificationStatus(userId, env) {
    const { primaryEmail, emails } = await getOwnedDestinations(userId, env);

    // Refresh from Cloudflare so a link the user just clicked shows up immediately.
    let syncError = null;
    try {
        await syncCfDestinations(env);
    } catch (error) {
        syncError = error.message;
        console.error('Destination sync failed:', error.message);
    }

    const states = await getCachedDestinationStates(env, emails);

    return Response.json({
        destinations: emails.map(email => {
            const state = states.get(email);
            return {
                email,
                isPrimary: email === primaryEmail,
                registered: Boolean(state),
                verified: Boolean(state?.verified),
            };
        }),
        allVerified: emails.every(email => states.get(email)?.verified),
        syncError,
    });
}

async function requestVerification(request, userId, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const email = (body.email || '').trim().toLowerCase();
    if (!email) {
        return Response.json({ error: 'email required' }, { status: 400 });
    }

    // Scope to addresses this user actually forwards to. Without this check the
    // endpoint lets anyone trigger Cloudflare verification mail to any inbox.
    const { emails } = await getOwnedDestinations(userId, env);
    if (!emails.includes(email)) {
        return Response.json(
            { error: 'This address is not one of your forwarding destinations' },
            { status: 403 }
        );
    }

    try {
        const result = await ensureCfDestination(env, email);
        return Response.json({
            email: result.email,
            verified: result.verified,
            message: result.verified
                ? 'Address is already verified.'
                : 'Cloudflare sent a verification email. Click the link in it to activate forwarding.',
        });
    } catch (error) {
        console.error(`Destination registration failed for ${email}:`, error.message);
        return Response.json(
            { error: 'Could not register this address with Cloudflare', detail: error.message },
            { status: 502 }
        );
    }
}

async function listDestinations(userId, aliasId, env) {
    // Verify alias ownership
    const alias = await env.DB.prepare(
        'SELECT id FROM aliases WHERE id = ? AND user_id = ?'
    ).bind(aliasId, userId).first();

    if (!alias) {
        return Response.json({ error: 'Alias not found' }, { status: 404 });
    }

    const { results } = await env.DB.prepare(
        'SELECT id, email, active, created_at FROM alias_destinations WHERE alias_id = ? ORDER BY created_at ASC'
    ).bind(aliasId).all();

    // Also get the user's primary email as the default destination
    const user = await env.DB.prepare(
        'SELECT email FROM users WHERE id = ?'
    ).bind(userId).first();

    // Verification state decides whether mail reaches this inbox via free native
    // forwarding or the metered fallback sender, so surface it in the list.
    // Skipped entirely when Cloudflare forwarding is off, so this endpoint keeps
    // working on a deploy that lands before migration-cf-destinations.sql is applied.
    const cfEnabled = isCfRoutingConfigured(env);
    let states = new Map();

    if (cfEnabled) {
        const allEmails = results.map(r => r.email);
        if (user?.email) allEmails.push(user.email);
        try {
            states = await getCachedDestinationStates(env, allEmails);
        } catch (error) {
            // Missing table or transient D1 error — the list itself is still useful.
            console.error('Could not read destination verification state:', error.message);
        }
    }

    return Response.json({
        destinations: results.map(row => ({
            id: row.id,
            email: row.email,
            active: Boolean(row.active),
            createdAt: row.created_at,
            verified: cfEnabled ? Boolean(states.get(row.email?.toLowerCase())?.verified) : null,
        })),
        primaryEmail: user?.email || '',
        primaryEmailVerified: cfEnabled
            ? Boolean(states.get(user?.email?.toLowerCase())?.verified)
            : null,
        count: results.length,
        limit: MAX_DESTINATIONS_PER_ALIAS,
    });
}

async function addDestination(request, userId, aliasId, env) {
    // Verify alias ownership
    const alias = await env.DB.prepare(
        'SELECT id FROM aliases WHERE id = ? AND user_id = ?'
    ).bind(aliasId, userId).first();

    if (!alias) {
        return Response.json({ error: 'Alias not found' }, { status: 404 });
    }

    // Check destination count
    const countResult = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM alias_destinations WHERE alias_id = ?'
    ).bind(aliasId).first();

    if ((countResult?.count ?? 0) >= MAX_DESTINATIONS_PER_ALIAS) {
        return Response.json(
            { error: `Maximum ${MAX_DESTINATIONS_PER_ALIAS} destinations per alias` },
            { status: 403 }
        );
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const email = (body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return Response.json({ error: 'Valid email address required' }, { status: 400 });
    }

    if (email.length > 254) {
        return Response.json({ error: 'Email too long' }, { status: 400 });
    }

    // Prevent adding the domain's own addresses as destinations (loop prevention)
    const domain = env.EMAIL_DOMAIN || 'ghostrelay.me';
    if (email.endsWith(`@${domain}`)) {
        return Response.json({ error: 'Cannot forward to another GhostRelay alias' }, { status: 400 });
    }

    // Check for duplicate
    const existing = await env.DB.prepare(
        'SELECT id FROM alias_destinations WHERE alias_id = ? AND email = ?'
    ).bind(aliasId, email).first();

    if (existing) {
        return Response.json({ error: 'This destination already exists' }, { status: 409 });
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
        'INSERT INTO alias_destinations (id, alias_id, email, active, created_at) VALUES (?, ?, ?, 1, ?)'
    ).bind(id, aliasId, email, new Date().toISOString()).run();

    // Register with Cloudflare so mail can be delivered by free native forwarding.
    // Cloudflare emails the address a verification link; until it's clicked, mail
    // falls back to the metered sender. Best effort — a Cloudflare API hiccup
    // shouldn't block adding the destination.
    let verified = null;
    let verificationMessage = null;

    if (isCfRoutingConfigured(env)) {
        try {
            const cf = await ensureCfDestination(env, email);
            verified = cf.verified;
            verificationMessage = cf.verified
                ? 'Address already verified — forwarding is active.'
                : 'Check this inbox for a Cloudflare verification email and click the link to activate forwarding.';
        } catch (error) {
            console.error(`Cloudflare destination registration failed for ${email}:`, error.message);
            verified = false;
            verificationMessage = 'Could not reach Cloudflare to start verification. Retry from the destination settings.';
        }
    }

    return Response.json({
        destination: {
            id,
            email,
            active: true,
            createdAt: new Date().toISOString(),
            verified,
        },
        verificationMessage,
    }, { status: 201 });
}

async function removeDestination(userId, aliasId, destId, env) {
    // Verify alias ownership
    const alias = await env.DB.prepare(
        'SELECT id FROM aliases WHERE id = ? AND user_id = ?'
    ).bind(aliasId, userId).first();

    if (!alias) {
        return Response.json({ error: 'Alias not found' }, { status: 404 });
    }

    const result = await env.DB.prepare(
        'DELETE FROM alias_destinations WHERE id = ? AND alias_id = ?'
    ).bind(destId, aliasId).run();

    if (result.meta.changes === 0) {
        return Response.json({ error: 'Destination not found' }, { status: 404 });
    }

    return Response.json({ success: true });
}

async function toggleDestination(request, userId, aliasId, destId, env) {
    // Verify alias ownership
    const alias = await env.DB.prepare(
        'SELECT id FROM aliases WHERE id = ? AND user_id = ?'
    ).bind(aliasId, userId).first();

    if (!alias) {
        return Response.json({ error: 'Alias not found' }, { status: 404 });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (typeof body.active !== 'boolean') {
        return Response.json({ error: 'active (boolean) required' }, { status: 400 });
    }

    const result = await env.DB.prepare(
        'UPDATE alias_destinations SET active = ? WHERE id = ? AND alias_id = ?'
    ).bind(body.active ? 1 : 0, destId, aliasId).run();

    if (result.meta.changes === 0) {
        return Response.json({ error: 'Destination not found' }, { status: 404 });
    }

    return Response.json({ success: true });
}
