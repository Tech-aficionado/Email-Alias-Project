/**
 * Authentication handler
 * HMAC-signed tokens + refresh tokens + device-aware sessions
 * Supports token revocation and session management
 */

import { ensureCfDestination, isCfRoutingConfigured } from './cf-destinations.js';

const ACCESS_TOKEN_EXPIRY = 15 * 60 * 1000; // 15 minutes
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days
const HASH_ITERATIONS = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;
const MIN_PASSWORD_LENGTH = 8;
const MAX_SESSIONS_PER_USER = 10;

// Email regex (RFC 5322 simplified)
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export async function handleAuth(request, env, path) {
    const method = request.method;

    if (method === 'POST' && path === '/api/auth/register') {
        let body;
        try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
        return register(body, env, request);
    }

    if (method === 'POST' && path === '/api/auth/login') {
        let body;
        try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
        return login(body, env, request);
    }

    if (method === 'POST' && path === '/api/auth/refresh') {
        let body;
        try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
        return refreshAccessToken(body, env);
    }

    if (method === 'POST' && path === '/api/auth/logout') {
        return logout(request, env);
    }

    if (method === 'GET' && path === '/api/auth/sessions') {
        return listSessions(request, env);
    }

    if (method === 'DELETE' && path.match(/^\/api\/auth\/sessions\/[a-f0-9-]+$/i)) {
        const sessionId = path.split('/').pop();
        return revokeSession(request, env, sessionId);
    }

    if (method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
}

async function register({ email, password }, env, request) {
    if (!email || !password) {
        return Response.json({ error: 'Email and password required' }, { status: 400 });
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
        return Response.json({ error: 'Invalid input types' }, { status: 400 });
    }

    email = email.trim().toLowerCase();

    if (email.length > MAX_EMAIL_LENGTH) {
        return Response.json({ error: 'Email too long' }, { status: 400 });
    }

    if (!EMAIL_REGEX.test(email)) {
        return Response.json({ error: 'Invalid email format' }, { status: 400 });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        return Response.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
        return Response.json({ error: 'Password too long' }, { status: 400 });
    }

    const existing = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();

    if (existing) {
        return Response.json({ error: 'User already exists' }, { status: 409 });
    }

    const salt = crypto.randomUUID();
    const passwordHash = await hashPassword(password, salt);

    const userId = crypto.randomUUID();
    await env.DB.prepare(
        'INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, email, passwordHash, salt, new Date().toISOString()).run();

    // Register the signup inbox as a Cloudflare destination address so alias mail
    // can be delivered by free native forwarding. Cloudflare sends a verification
    // link; forwarding stays on the metered fallback sender until it's clicked.
    // Best effort — never block account creation on this.
    let destinationVerified = null;
    if (isCfRoutingConfigured(env)) {
        try {
            const cf = await ensureCfDestination(env, email);
            destinationVerified = cf.verified;
        } catch (error) {
            console.error(`Cloudflare destination registration failed for ${email}:`, error.message);
            destinationVerified = false;
        }
    }

    // Create session with tokens
    const deviceName = parseUserAgent(request.headers.get('User-Agent') || '');
    const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { accessToken, refreshToken, sessionId } = await createSession(userId, env, deviceName, ipAddress);

    return Response.json({
        user: { id: userId, email },
        token: accessToken,
        refreshToken,
        sessionId,
        destinationVerified,
        verificationMessage: destinationVerified === false
            ? 'Check your inbox for a Cloudflare verification email — click the link to activate mail forwarding.'
            : null,
    }, { status: 201 });
}

async function login({ email, password }, env, request) {
    if (!email || !password) {
        return Response.json({ error: 'Email and password required' }, { status: 400 });
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
        return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    email = email.trim().toLowerCase();

    if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const user = await env.DB.prepare(
        'SELECT id, email, password_hash, salt FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user) {
        await hashPassword(password, 'dummy-salt-for-timing');
        return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const isValid = await verifyPassword(password, user.salt, user.password_hash);

    if (!isValid) {
        return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Upgrade legacy hash
    if (!user.password_hash.startsWith('v2:')) {
        const newHash = await hashPassword(password, user.salt);
        await env.DB.prepare(
            'UPDATE users SET password_hash = ? WHERE id = ?'
        ).bind(newHash, user.id).run();
    }

    // Enforce max sessions — remove oldest if at limit
    await enforceSessionLimit(user.id, env);

    // Update last_login_at
    try {
        await env.DB.prepare(
            'UPDATE users SET last_login_at = ? WHERE id = ?'
        ).bind(new Date().toISOString(), user.id).run();
    } catch { /* column might not exist yet */ }

    // Create session
    const deviceName = parseUserAgent(request.headers.get('User-Agent') || '');
    const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { accessToken, refreshToken, sessionId } = await createSession(user.id, env, deviceName, ipAddress);

    return Response.json({
        user: { id: user.id, email: user.email },
        token: accessToken,
        refreshToken,
        sessionId,
    });
}

/**
 * Refresh an expired access token using a valid refresh token
 */
async function refreshAccessToken({ refreshToken }, env) {
    try {
        if (!refreshToken || typeof refreshToken !== 'string') {
            return Response.json({ error: 'Refresh token required' }, { status: 400 });
        }

        if (refreshToken.length > 4096) {
            return Response.json({ error: 'Invalid token' }, { status: 401 });
        }

        // Hash the refresh token to look it up
        const tokenHash = await sha256Hex(refreshToken);

        const session = await env.DB.prepare(
            'SELECT id, user_id, expires_at, revoked FROM sessions WHERE token_hash = ?'
        ).bind(tokenHash).first();

        if (!session) {
            return Response.json({ error: 'Invalid refresh token' }, { status: 401 });
        }

        if (session.revoked) {
            return Response.json({ error: 'Session has been revoked' }, { status: 401 });
        }

        if (new Date(session.expires_at) < new Date()) {
            return Response.json({ error: 'Refresh token expired. Please login again.' }, { status: 401 });
        }

        // Update last_used_at
        await env.DB.prepare(
            'UPDATE sessions SET last_used_at = ? WHERE id = ?'
        ).bind(new Date().toISOString(), session.id).run();

        // Issue new access token (short-lived)
        const accessToken = await generateAccessToken(session.user_id, session.id, env);

        return Response.json({
            token: accessToken,
            sessionId: session.id,
        });
    } catch (error) {
        console.error('Refresh token error:', error.message || error);
        return Response.json({ error: 'Failed to refresh session. Please login again.' }, { status: 401 });
    }
}

/**
 * Logout — revoke the current session
 */
async function logout(request, env) {
    const userId = await authenticateRequest(request, env);
    if (!userId) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get session ID from the access token
    const token = request.headers.get('Authorization')?.substring(7)?.trim();
    const payload = await decodeTokenPayload(token, env);

    if (payload?.sid) {
        await env.DB.prepare(
            'UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?'
        ).bind(payload.sid, userId).run();
    }

    return Response.json({ success: true });
}

/**
 * List all active sessions for the authenticated user
 */
async function listSessions(request, env) {
    const userId = await authenticateRequest(request, env);
    if (!userId) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { results } = await env.DB.prepare(
        'SELECT id, device_name, ip_address, created_at, last_used_at, revoked FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_used_at DESC'
    ).bind(userId, new Date().toISOString()).all();

    // Get current session ID from token
    const token = request.headers.get('Authorization')?.substring(7)?.trim();
    const tokenParts = token ? token.split('.') : [];
    let currentSessionId = null;

    // Only custom tokens (2-part) have session IDs
    if (tokenParts.length === 2) {
        const payload = await decodeTokenPayload(token, env);
        currentSessionId = payload?.sid || null;
    }

    // For Firebase users with no sessions, show their current login as a virtual session
    if (results.length === 0) {
        const deviceName = parseUserAgent(request.headers.get('User-Agent') || '');
        const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';

        return Response.json({
            sessions: [{
                id: 'current',
                deviceName,
                ipAddress,
                createdAt: new Date().toISOString(),
                lastUsedAt: new Date().toISOString(),
                isCurrent: true,
            }],
        });
    }

    return Response.json({
        sessions: results.map(s => ({
            id: s.id,
            deviceName: s.device_name,
            ipAddress: s.ip_address,
            createdAt: s.created_at,
            lastUsedAt: s.last_used_at,
            isCurrent: s.id === currentSessionId,
        })),
    });
}

/**
 * Revoke a specific session (logout device)
 */
async function revokeSession(request, env, sessionId) {
    const userId = await authenticateRequest(request, env);
    if (!userId) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await env.DB.prepare(
        'UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?'
    ).bind(sessionId, userId).run();

    if (result.meta.changes === 0) {
        return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    return Response.json({ success: true });
}

// ===== Session Helpers =====

/**
 * Create a new session with access + refresh tokens
 */
async function createSession(userId, env, deviceName, ipAddress) {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY).toISOString();

    // Generate refresh token (random, stored as hash)
    const refreshToken = generateSecureToken();
    const tokenHash = await sha256Hex(refreshToken);

    await env.DB.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, device_name, ip_address, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(sessionId, userId, tokenHash, deviceName, ipAddress, now, expiresAt, now).run();

    // Generate short-lived access token
    const accessToken = await generateAccessToken(userId, sessionId, env);

    return { accessToken, refreshToken, sessionId };
}

/**
 * Generate a short-lived access token (15 min)
 */
async function generateAccessToken(userId, sessionId, env) {
    const payload = {
        sub: userId,
        sid: sessionId,
        exp: Date.now() + ACCESS_TOKEN_EXPIRY,
        iat: Date.now(),
        jti: crypto.randomUUID(),
    };

    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(payload));
    const key = await getSigningKey(env);

    const signature = await crypto.subtle.sign('HMAC', key, data);
    const sigArray = Array.from(new Uint8Array(signature));
    const sigBase64 = btoa(String.fromCharCode(...sigArray));

    return btoa(JSON.stringify(payload)) + '.' + sigBase64;
}

/**
 * Decode token payload without full verification (for extracting session ID)
 */
async function decodeTokenPayload(token, env) {
    try {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 2) return null;
        return JSON.parse(atob(parts[0]));
    } catch {
        return null;
    }
}

/**
 * Enforce maximum sessions per user — remove oldest expired/unused sessions
 */
async function enforceSessionLimit(userId, env) {
    const { results } = await env.DB.prepare(
        'SELECT id FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_used_at DESC'
    ).bind(userId, new Date().toISOString()).all();

    if (results.length >= MAX_SESSIONS_PER_USER) {
        // Revoke oldest sessions beyond the limit
        const toRevoke = results.slice(MAX_SESSIONS_PER_USER - 1);
        for (const session of toRevoke) {
            await env.DB.prepare(
                'UPDATE sessions SET revoked = 1 WHERE id = ?'
            ).bind(session.id).run();
        }
    }
}

// ===== Token Verification (exported for use in other modules) =====

export async function verifyToken(token, env) {
    try {
        if (!token || typeof token !== 'string') return null;

        const parts = token.split('.');
        if (parts.length !== 2) return null;

        const [payloadB64, sigB64] = parts;

        let payload;
        try {
            payload = JSON.parse(atob(payloadB64));
        } catch {
            return null;
        }

        if (!payload.sub || !payload.exp || !payload.iat) return null;

        // Check expiry
        if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
            return null;
        }

        // Check issued time isn't in the future (60s clock skew tolerance)
        if (typeof payload.iat !== 'number' || payload.iat > Date.now() + 60000) {
            return null;
        }

        // Verify signature
        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(payload));
        const key = await getSigningKey(env);

        const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
        const valid = await crypto.subtle.verify('HMAC', key, sigBytes, data);

        if (!valid) return null;

        // Check if session is revoked (if session ID present)
        if (payload.sid) {
            const session = await env.DB.prepare(
                'SELECT revoked FROM sessions WHERE id = ?'
            ).bind(payload.sid).first();

            if (session && session.revoked) {
                return null; // Session was revoked
            }
        }

        return payload;
    } catch {
        return null;
    }
}

export async function authenticateRequest(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.substring(7).trim();
    if (token.length > 4096) return null;

    // Try custom HMAC token first (2-part format)
    const parts = token.split('.');
    if (parts.length === 2) {
        const payload = await verifyToken(token, env);
        if (payload) return payload.sub;
    }

    // Try Firebase JWT (3-part format)
    if (parts.length === 3) {
        const firebaseUserId = await verifyFirebaseToken(token, env);
        if (firebaseUserId) return firebaseUserId;
    }

    return null;
}

/**
 * Verify a Firebase ID token (RS256 JWT from Google)
 * Returns the user ID (sub claim) if valid, null otherwise
 */
async function verifyFirebaseToken(token, env) {
    try {
        const [headerB64, payloadB64, signatureB64] = token.split('.');

        // Decode header and payload
        const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

        // Validate basic JWT claims
        const projectId = 'ghostrelay-5dde0';
        const now = Math.floor(Date.now() / 1000);

        if (header.alg !== 'RS256') return null;
        if (!payload.sub || typeof payload.sub !== 'string') return null;
        if (payload.aud !== projectId) return null;
        if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
        if (payload.exp < now) return null;
        if (payload.iat > now + 60) return null; // Allow 60s clock skew

        // Verify signature using Google's public keys
        const keyId = header.kid;
        if (!keyId) return null;

        const publicKey = await getGooglePublicKey(keyId);
        if (!publicKey) return null;

        // Verify RS256 signature
        const signedContent = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

        const valid = await crypto.subtle.verify(
            { name: 'RSASSA-PKCS1-v1_5' },
            publicKey,
            signature,
            signedContent
        );

        if (!valid) return null;

        // Ensure user exists in our DB (auto-create for Firebase users)
        const userId = payload.sub;
        const email = payload.email || '';

        const existing = await env.DB.prepare(
            'SELECT id FROM users WHERE id = ?'
        ).bind(userId).first();

        if (!existing && email) {
            // Auto-create user record for Firebase-authenticated users
            try {
                await env.DB.prepare(
                    "INSERT OR IGNORE INTO users (id, email, password_hash, salt, created_at, last_login_at) VALUES (?, ?, 'firebase', 'firebase', ?, ?)"
                ).bind(userId, email, new Date().toISOString(), new Date().toISOString()).run();
            } catch {
                // May already exist with a different ID but same email
                const byEmail = await env.DB.prepare(
                    'SELECT id FROM users WHERE email = ?'
                ).bind(email).first();
                if (byEmail) return byEmail.id;
            }
        } else if (existing) {
            // Update last_login_at on each verification (throttled — only if older than 5 min)
            try {
                await env.DB.prepare(
                    "UPDATE users SET last_login_at = ? WHERE id = ? AND (last_login_at IS NULL OR last_login_at < ?)"
                ).bind(new Date().toISOString(), userId, new Date(Date.now() - 300000).toISOString()).run();
            } catch { /* column might not exist yet */ }
        }

        return userId;
    } catch (error) {
        console.error('Firebase token verification error:', error.message || error);
        return null;
    }
}

// Cache Google's public keys (they rotate infrequently)
let googleKeysCache = null;
let googleKeysCacheExpiry = 0;

async function getGooglePublicKey(keyId) {
    const now = Date.now();

    // Fetch keys if not cached or expired
    if (!googleKeysCache || now > googleKeysCacheExpiry) {
        try {
            const res = await fetch(
                'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
            );
            if (!res.ok) return null;

            const keys = await res.json();
            googleKeysCache = {};

            // Import all keys as CryptoKey objects
            for (const [kid, cert] of Object.entries(keys)) {
                const pemBody = cert
                    .replace('-----BEGIN CERTIFICATE-----', '')
                    .replace('-----END CERTIFICATE-----', '')
                    .replace(/\s/g, '');
                const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

                try {
                    const cryptoKey = await crypto.subtle.importKey(
                        'spki',
                        extractPublicKeyFromCert(binaryDer),
                        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                        false,
                        ['verify']
                    );
                    googleKeysCache[kid] = cryptoKey;
                } catch {
                    // Skip invalid keys
                }
            }

            // Cache for 1 hour
            googleKeysCacheExpiry = now + 3600000;
        } catch {
            return null;
        }
    }

    return googleKeysCache?.[keyId] || null;
}

/**
 * Extract SubjectPublicKeyInfo from an X.509 DER certificate
 * This is a simplified ASN.1 parser for the specific structure we need
 */
function extractPublicKeyFromCert(certDer) {
    // X.509 certificate structure (simplified):
    // SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
    // tbsCertificate SEQUENCE { version, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, ... }
    // We need to find subjectPublicKeyInfo which starts with SEQUENCE { algorithm, BIT STRING { publicKey } }

    // Look for the RSA OID (1.2.840.113549.1.1.1) in the certificate
    // which precedes the public key
    const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

    let offset = -1;
    for (let i = 0; i < certDer.length - rsaOid.length; i++) {
        let match = true;
        for (let j = 0; j < rsaOid.length; j++) {
            if (certDer[i + j] !== rsaOid[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            // Found the OID, now we need to go back to find the SEQUENCE that contains it
            // The subjectPublicKeyInfo SEQUENCE starts a few bytes before the algorithm SEQUENCE
            // Walk backwards to find the enclosing SEQUENCE (0x30)
            let seqStart = i - 2; // skip OID tag and length
            while (seqStart > 0 && certDer[seqStart] !== 0x30) {
                seqStart--;
            }
            // Go one more SEQUENCE back for the subjectPublicKeyInfo wrapper
            seqStart--;
            while (seqStart > 0 && certDer[seqStart] !== 0x30) {
                seqStart--;
            }
            offset = seqStart;
            break;
        }
    }

    if (offset === -1) return certDer; // Fallback: try the whole thing

    // Read the SEQUENCE length at offset to get the full subjectPublicKeyInfo
    const tag = certDer[offset];
    if (tag !== 0x30) return certDer;

    let len = certDer[offset + 1];
    let headerLen = 2;
    if (len & 0x80) {
        const numBytes = len & 0x7f;
        len = 0;
        for (let i = 0; i < numBytes; i++) {
            len = (len << 8) | certDer[offset + 2 + i];
        }
        headerLen = 2 + numBytes;
    }

    return certDer.slice(offset, offset + headerLen + len);
}

// ===== Crypto Helpers =====

async function hashPassword(password, salt) {
    const encoder = new TextEncoder();
    let data = encoder.encode(salt + password + salt);

    for (let i = 0; i < HASH_ITERATIONS; i++) {
        data = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    }

    const hashArray = Array.from(data);
    return 'v2:' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPasswordLegacy(password, salt) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + salt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, salt, storedHash) {
    if (storedHash.startsWith('v2:')) {
        const computed = await hashPassword(password, salt);
        return timingSafeEqual(computed, storedHash);
    } else {
        const computed = await hashPasswordLegacy(password, salt);
        return timingSafeEqual(computed, storedHash);
    }
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

async function getSigningKey(env) {
    const secret = env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not configured');
    }
    const encoder = new TextEncoder();
    return crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
    );
}

/**
 * Generate a cryptographically secure random token (URL-safe base64)
 */
function generateSecureToken() {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * SHA-256 hex hash of a string
 */
async function sha256Hex(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse User-Agent into a friendly device name
 */
function parseUserAgent(ua) {
    if (!ua) return 'Unknown device';

    let browser = 'Unknown';
    let os = 'Unknown';

    // Browser detection
    if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Opera') || ua.includes('OPR/')) browser = 'Opera';

    // OS detection
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

    return `${browser} on ${os}`;
}
