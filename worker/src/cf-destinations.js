/**
 * Cloudflare Email Routing destination addresses
 *
 * Forwarding via `message.forward()` is free and unmetered, but Cloudflare only
 * allows it to *verified destination addresses* on the account. This module:
 *   - registers a user's inbox as a Cloudflare destination address
 *   - caches verification state in D1 so the email hot path never makes an
 *     outbound API call
 *   - exposes an API for the dashboard to trigger/poll verification
 *
 * Requires two secrets:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN   (permission: Account > Email Routing Addresses > Edit)
 *
 * Docs: https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/
 *
 * This module deliberately has no internal imports — `auth.js` depends on it for
 * signup, so pulling auth in here would create an import cycle. The authenticated
 * HTTP surface lives in `destinations.js`.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const PAGE_SIZE = 50;
const MAX_PAGES = 10; // account cap is 200 destinations; 10 pages is generous headroom

/** Cloudflare's per-account limit on verified destination addresses. */
export const CF_DESTINATION_LIMIT = 200;

/**
 * Whether Cloudflare destination management is configured. When false the
 * worker falls back to the ESP send path for everything.
 */
export function isCfRoutingConfigured(env) {
    return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
}

async function cfFetch(env, path, init = {}) {
    const res = await fetch(`${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/routing/addresses${path}`, {
        ...init,
        headers: {
            'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });

    let body = null;
    try {
        body = await res.json();
    } catch { /* non-JSON error page */ }

    if (!res.ok || (body && body.success === false)) {
        const detail = body?.errors?.map(e => `${e.code}: ${e.message}`).join('; ')
            || `HTTP ${res.status}`;
        const err = new Error(`Cloudflare Email Routing API — ${detail}`);
        err.status = res.status;
        err.cfErrors = body?.errors || [];
        throw err;
    }

    return body;
}

// ===== D1 cache =====

/**
 * Read cached verification state for a set of addresses.
 * Returns a Map of lowercased email -> { verified: boolean, cfTag: string|null }.
 * Emails with no cache row are simply absent from the map.
 */
export async function getCachedDestinationStates(env, emails) {
    const unique = [...new Set(emails.filter(Boolean).map(e => e.toLowerCase()))];
    if (unique.length === 0) return new Map();

    const placeholders = unique.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
        `SELECT email, cf_tag, verified FROM cf_destinations WHERE email IN (${placeholders})`
    ).bind(...unique).all();

    const map = new Map();
    for (const row of results || []) {
        map.set(row.email, { verified: Boolean(row.verified), cfTag: row.cf_tag || null });
    }
    return map;
}

/**
 * Filter a destination list down to the ones Cloudflare will accept for
 * `message.forward()`. Returns { forwardable, unverified }.
 */
export async function partitionByVerification(env, destinations) {
    if (!isCfRoutingConfigured(env)) {
        return { forwardable: [], unverified: [...destinations] };
    }

    const states = await getCachedDestinationStates(env, destinations);
    const forwardable = [];
    const unverified = [];

    for (const dest of destinations) {
        if (states.get(dest.toLowerCase())?.verified) {
            forwardable.push(dest);
        } else {
            unverified.push(dest);
        }
    }

    return { forwardable, unverified };
}

async function upsertCache(env, { email, cfTag, verified }) {
    const now = new Date().toISOString();
    await env.DB.prepare(`
        INSERT INTO cf_destinations (email, cf_tag, verified, last_synced_at, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            cf_tag = COALESCE(excluded.cf_tag, cf_destinations.cf_tag),
            verified = excluded.verified,
            last_synced_at = excluded.last_synced_at
    `).bind(email.toLowerCase(), cfTag || null, verified ? 1 : 0, now, now).run();
}

// ===== Cloudflare operations =====

/**
 * Register an address as a Cloudflare destination so it can receive forwards.
 * Cloudflare emails the address a verification link; forwarding stays blocked
 * until the owner clicks it.
 *
 * Idempotent: an address Cloudflare already knows about resolves to its
 * current state instead of erroring.
 *
 * @returns {Promise<{email: string, verified: boolean, alreadyExisted: boolean}>}
 */
export async function ensureCfDestination(env, email) {
    const normalized = email.toLowerCase().trim();

    try {
        const body = await cfFetch(env, '', {
            method: 'POST',
            body: JSON.stringify({ email: normalized }),
        });

        const verified = Boolean(body?.result?.verified);
        await upsertCache(env, { email: normalized, cfTag: body?.result?.tag, verified });
        return { email: normalized, verified, alreadyExisted: false };
    } catch (err) {
        // Already registered (Cloudflare returns a duplicate error) — fall back to
        // reading its current state rather than treating this as a failure.
        const isDuplicate = err.status === 409
            || err.cfErrors?.some(e => /exist|duplicate|already/i.test(e.message || ''));

        if (!isDuplicate) throw err;

        const existing = await findCfDestination(env, normalized);
        if (existing) {
            await upsertCache(env, {
                email: normalized,
                cfTag: existing.tag,
                verified: Boolean(existing.verified),
            });
            return { email: normalized, verified: Boolean(existing.verified), alreadyExisted: true };
        }

        throw err;
    }
}

/** Look up a single destination address on Cloudflare by email. */
async function findCfDestination(env, email) {
    const all = await listCfDestinations(env);
    return all.find(a => (a.email || '').toLowerCase() === email.toLowerCase()) || null;
}

/** List every destination address on the account (handles pagination). */
export async function listCfDestinations(env) {
    const addresses = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await cfFetch(env, `?page=${page}&per_page=${PAGE_SIZE}`, { method: 'GET' });
        const batch = body?.result || [];
        addresses.push(...batch);
        if (batch.length < PAGE_SIZE) break;
    }

    return addresses;
}

/**
 * Pull the full destination list from Cloudflare and refresh the D1 cache.
 * Safe to call from a cron trigger or an on-demand dashboard request.
 *
 * @returns {Promise<{total: number, verified: number}>}
 */
export async function syncCfDestinations(env) {
    const addresses = await listCfDestinations(env);
    const now = new Date().toISOString();

    // D1 has no true bulk upsert; batch() keeps this to a single round trip.
    const statements = addresses.map(addr => env.DB.prepare(`
        INSERT INTO cf_destinations (email, cf_tag, verified, last_synced_at, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            cf_tag = excluded.cf_tag,
            verified = excluded.verified,
            last_synced_at = excluded.last_synced_at
    `).bind(
        (addr.email || '').toLowerCase(),
        addr.tag || null,
        addr.verified ? 1 : 0,
        now,
        addr.created || now
    ));

    if (statements.length > 0) {
        await env.DB.batch(statements);
    }

    // Addresses deleted on Cloudflare's side must lose their verified flag,
    // otherwise the hot path keeps trying to forward to them.
    const knownEmails = addresses.map(a => (a.email || '').toLowerCase()).filter(Boolean);
    if (knownEmails.length > 0) {
        const placeholders = knownEmails.map(() => '?').join(',');
        await env.DB.prepare(
            `UPDATE cf_destinations SET verified = 0, last_synced_at = ? WHERE email NOT IN (${placeholders})`
        ).bind(now, ...knownEmails).run();
    } else {
        await env.DB.prepare('UPDATE cf_destinations SET verified = 0, last_synced_at = ?')
            .bind(now).run();
    }

    return {
        total: addresses.length,
        verified: addresses.filter(a => a.verified).length,
    };
}

/**
 * Every address a user's mail can be forwarded to: their primary inbox plus any
 * per-alias destinations. Used to scope verification requests to owned addresses.
 */
export async function getOwnedDestinations(userId, env) {
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
        .bind(userId).first();

    const { results } = await env.DB.prepare(`
        SELECT DISTINCT d.email
        FROM alias_destinations d
        JOIN aliases a ON d.alias_id = a.id
        WHERE a.user_id = ?
    `).bind(userId).all();

    const emails = new Set();
    if (user?.email) emails.add(user.email.toLowerCase());
    for (const row of results || []) {
        if (row.email) emails.add(row.email.toLowerCase());
    }

    return { primaryEmail: user?.email?.toLowerCase() || '', emails: [...emails] };
}
