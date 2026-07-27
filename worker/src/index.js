/**
 * GhostRelay - Cloudflare Worker
 * Main entry point, router, security middleware
 */

import { handleAuth } from './auth.js';
import { handleAliases } from './aliases.js';
import { handleEmail, handleEmailWebhook } from './email.js';
import { handleBounces } from './bounces.js';
import { handleEmailLogs } from './email-logs.js';
import { handleBlocklist } from './blocklist.js';
import { handleAnalytics } from './analytics.js';
import { handlePasswordReset } from './password-reset.js';
import { handleWildcards } from './wildcards.js';
import { handleDestinations, handleDestinationVerification } from './destinations.js';
import { syncCfDestinations, isCfRoutingConfigured } from './cf-destinations.js';
import { handlePush } from './push.js';
import { handleTwoFactor } from './two-factor.js';
import { handleSecurity } from './security.js';
import { handleSettings } from './settings.js';

// Allowed frontend origins
const ALLOWED_ORIGINS = [
    'https://www.ghostrelay.me',
    'https://ghostrelay.me',
    'https://frontend-pearl-six-47.vercel.app',
];

// Rate limiting state (per-worker instance, resets on cold start)
// For production scale, use Cloudflare KV or Durable Objects
const rateLimits = new Map();

function isOriginAllowed(origin) {
    if (!origin) return false;
    // Allow browser extension (chrome-extension:// origins)
    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
    return ALLOWED_ORIGINS.includes(origin);
}

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = isOriginAllowed(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

/**
 * Simple in-memory rate limiter
 * Returns true if request is allowed, false if rate limited
 */
function checkRateLimit(key, maxRequests, windowMs) {
    const now = Date.now();
    const entry = rateLimits.get(key);

    if (!entry || now - entry.start > windowMs) {
        rateLimits.set(key, { start: now, count: 1 });
        return true;
    }

    if (entry.count >= maxRequests) {
        return false;
    }

    entry.count++;
    return true;
}

// Clean up old rate limit entries periodically
function cleanRateLimits() {
    const now = Date.now();
    for (const [key, entry] of rateLimits) {
        if (now - entry.start > 120000) { // 2 min stale
            rateLimits.delete(key);
        }
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const corsHeaders = getCorsHeaders(request);

        // Handle preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Reject oversized requests (1MB max)
        const contentLength = request.headers.get('Content-Length');
        if (contentLength && parseInt(contentLength) > 1048576) {
            return Response.json(
                { error: 'Request too large' },
                { status: 413, headers: corsHeaders }
            );
        }

        // Get client IP for rate limiting
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

        // Clean stale rate limit entries occasionally
        if (Math.random() < 0.01) cleanRateLimits();

        try {
            let response;

            if (path.startsWith('/api/security')) {
                // Rate limit security: 15 requests per 60 seconds per IP
                if (!checkRateLimit(`security:${clientIP}`, 15, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleSecurity(request, env, path);
            } else if (path.startsWith('/api/settings')) {
                // Rate limit settings: 10 requests per 60 seconds per IP
                if (!checkRateLimit(`settings:${clientIP}`, 10, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleSettings(request, env, path);
            } else if (path.startsWith('/api/auth')) {
                // Rate limit auth: 10 requests per 60 seconds per IP
                if (!checkRateLimit(`auth:${clientIP}`, 10, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please wait and try again.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                // Password reset endpoints
                if (path.startsWith('/api/auth/forgot-password') || path.startsWith('/api/auth/reset-password') || path.startsWith('/api/auth/verify-reset-token')) {
                    response = await handlePasswordReset(request, env, path);
                } else if (path.startsWith('/api/auth/2fa')) {
                    response = await handleTwoFactor(request, env, path);
                } else if (path === '/api/auth/sessions/revoke-all') {
                    response = await handleSecurity(request, env, path);
                } else {
                    response = await handleAuth(request, env, path);
                }
            } else if (path.startsWith('/api/email-logs')) {
                // Rate limit log queries: 20 requests per 60 seconds per IP
                if (!checkRateLimit(`logs:${clientIP}`, 20, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleEmailLogs(request, env, path);
            } else if (path.startsWith('/api/blocklist')) {
                // Rate limit blocklist: 20 requests per 60 seconds per IP
                if (!checkRateLimit(`blocklist:${clientIP}`, 20, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleBlocklist(request, env, path);
            } else if (path.startsWith('/api/analytics')) {
                // Rate limit analytics: 15 requests per 60 seconds per IP
                if (!checkRateLimit(`analytics:${clientIP}`, 15, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleAnalytics(request, env, path);
            } else if (path.startsWith('/api/aliases') && path.includes('/destinations')) {
                // Rate limit destination operations: 20 requests per 60 seconds per IP
                if (!checkRateLimit(`dest:${clientIP}`, 20, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleDestinations(request, env, path);
            } else if (path.startsWith('/api/destinations')) {
                // Cloudflare destination-address verification status / re-send.
                // Tighter limit than CRUD: each verify call sends real email.
                if (!checkRateLimit(`destverify:${clientIP}`, 10, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleDestinationVerification(request, env, path);
            } else if (path.startsWith('/api/wildcards')) {
                // Rate limit wildcard operations: 20 requests per 60 seconds per IP
                if (!checkRateLimit(`wildcard:${clientIP}`, 20, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleWildcards(request, env, path);
            } else if (path.startsWith('/api/push')) {
                // Rate limit push operations: 10 requests per 60 seconds per IP
                if (!checkRateLimit(`push:${clientIP}`, 10, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handlePush(request, env, path);
            } else if (path.startsWith('/api/aliases')) {
                // Rate limit alias operations: 30 requests per 60 seconds per IP
                if (!checkRateLimit(`alias:${clientIP}`, 30, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleAliases(request, env, path);
            } else if (path.startsWith('/api/bounces')) {
                // Rate limit bounce queries: 20 requests per 60 seconds per IP
                if (!checkRateLimit(`bounces:${clientIP}`, 20, 60000)) {
                    return Response.json(
                        { error: 'Too many requests. Please slow down.' },
                        { status: 429, headers: corsHeaders }
                    );
                }
                response = await handleBounces(request, env, path);
            } else if (path === '/api/webhooks/email-events') {
                // Resend webhook for bounce/complaint notifications (no rate limit — server-to-server)
                response = await handleEmailWebhook(request, env);
            } else if (path === '/api/health') {
                response = Response.json({ status: 'ok' });
            } else {
                response = Response.json({ error: 'Not found' }, { status: 404 });
            }

            // Add CORS + security headers
            const newHeaders = new Headers(response.headers);
            Object.entries(corsHeaders).forEach(([key, value]) => {
                newHeaders.set(key, value);
            });
            newHeaders.set('X-Content-Type-Options', 'nosniff');
            newHeaders.set('X-Frame-Options', 'DENY');
            newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

            return new Response(response.body, {
                status: response.status,
                headers: newHeaders,
            });
        } catch (error) {
            console.error('Worker error:', error);
            return Response.json(
                { error: 'Internal server error' },
                { status: 500, headers: corsHeaders }
            );
        }
    },

    async email(message, env) {
        await handleEmail(message, env);
    },

    /**
     * Keeps the local cache of verified Cloudflare destination addresses fresh.
     * Without this, an address verified (or deleted) outside the dashboard would
     * stay stale and forwarding would silently fall back to the metered sender.
     */
    async scheduled(event, env, ctx) {
        if (!isCfRoutingConfigured(env)) return;

        try {
            const result = await syncCfDestinations(env);
            console.log(`Destination sync: ${result.verified}/${result.total} verified`);
        } catch (error) {
            console.error('Scheduled destination sync failed:', error.message || error);
        }
    },
};
