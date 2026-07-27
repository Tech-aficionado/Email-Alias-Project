# GhostRelay — Project Context & Reference

> A privacy-focused email aliasing service built on Cloudflare's free tier.  
> Users generate ghost email addresses that forward to their real inbox.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER BROWSER                               │
│  Next.js Frontend (Vercel / Cloudflare Pages)                     │
│  - Landing page (/)                                              │
│  - Dashboard (/dashboard) — auth + alias management              │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS (REST API)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE WORKER                               │
│  - /api/auth/register, /api/auth/login                           │
│  - /api/aliases (CRUD)                                           │
│  - /api/health                                                   │
│  - Email handler (Cloudflare Email Routing)                      │
└────────────────────────────┬─────────────────────────────────────┘
                             │ D1 Binding
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE D1 (SQLite)                          │
│  Tables: users, aliases, email_logs                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer       | Technology                     | Hosting               |
|-------------|--------------------------------|-----------------------|
| Frontend    | Next.js 16 + React 19 + TS     | Vercel or CF Pages    |
| Styling     | Tailwind CSS v4                | —                     |
| Backend     | Cloudflare Worker (ES modules) | CF Workers (free)     |
| Database    | Cloudflare D1 (SQLite)         | CF D1 (free)          |
| Email       | Cloudflare Email Routing       | CF (free)             |
| Auth        | Custom HMAC tokens (SHA-256)   | —                     |

---

## Project Structure

```
GhostRelay/
├── CONTEXT.md                       ← THIS FILE
├── README.md                        ← Setup guide & overview
├── database/
│   └── schema.sql                   ← D1 database schema
├── frontend/                        ← Next.js 16 app
│   ├── .env.local                   ← Local env vars (not committed)
│   ├── .env.example                 ← Template for env vars
│   ├── package.json
│   ├── next.config.ts
│   ├── tsconfig.json
│   ├── postcss.config.mjs           ← Tailwind v4 via @tailwindcss/postcss
│   ├── eslint.config.mjs
│   └── src/
│       ├── app/
│       │   ├── layout.tsx           ← Root layout (dark theme)
│       │   ├── globals.css          ← Theme vars + animations
│       │   ├── page.tsx             ← Landing page
│       │   └── dashboard/
│       │       └── page.tsx         ← Main dashboard (auth + aliases)
│       ├── components/
│       │   ├── Navbar.tsx           ← Landing page nav
│       │   ├── DashboardNav.tsx     ← Dashboard nav + logout
│       │   ├── AuthForm.tsx         ← Login/register form
│       │   ├── AliasItem.tsx        ← Alias row component
│       │   ├── CreateAliasModal.tsx ← New alias modal
│       │   └── Toast.tsx            ← Notification toast
│       └── lib/
│           ├── api.ts              ← API client (Worker endpoints)
│           └── auth.ts             ← Token/user storage utilities
└── worker/                          ← Cloudflare Worker backend
    ├── package.json
    ├── wrangler.toml                ← Worker config (D1, vars, etc.)
    └── src/
        ├── index.js                 ← Entry point, router, CORS
        ├── auth.js                  ← Register/login, token gen/verify
        ├── aliases.js               ← Alias CRUD operations
        └── email.js                 ← Email forwarding handler
```

---

## API Endpoints

| Method | Endpoint             | Auth Required | Description              |
|--------|----------------------|---------------|--------------------------|
| POST   | /api/auth/register   | No            | Register new user        |
| POST   | /api/auth/login      | No            | Login, returns token     |
| GET    | /api/aliases         | Yes (Bearer)  | List user's aliases      |
| POST   | /api/aliases         | Yes (Bearer)  | Create new alias         |
| PATCH  | /api/aliases/:id     | Yes (Bearer)  | Toggle active / update   |
| DELETE | /api/aliases/:id     | Yes (Bearer)  | Delete alias             |
| GET    | /api/health          | No            | Health check             |

### Auth Header Format
```
Authorization: Bearer <token>
```

### Response Shapes

**POST /api/auth/register & /api/auth/login:**
```json
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "token": "base64payload.base64signature"
}
```

**GET /api/aliases:**
```json
{
  "aliases": [
    {
      "id": "uuid",
      "address": "xk7r9m@ghostrelay.me",
      "label": "Shopping",
      "active": true,
      "forwarded": 12,
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "count": 1,
  "limit": 5
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    created_at TEXT NOT NULL,
    updated_at TEXT
);

-- Email Aliases
CREATE TABLE aliases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    address TEXT UNIQUE NOT NULL,
    label TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    forwarded_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Forwarding Logs
CREATE TABLE email_logs (
    id TEXT PRIMARY KEY,
    alias_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT DEFAULT '',
    forwarded_at TEXT NOT NULL,
    FOREIGN KEY (alias_id) REFERENCES aliases(id) ON DELETE CASCADE
);
```

---

## Running Locally

### Frontend (Next.js)

```bash
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

The frontend works in **demo mode** (localStorage) if no backend is available.  
When the Worker is running, it connects automatically via `NEXT_PUBLIC_API_URL`.

### Backend (Cloudflare Worker)

```bash
cd worker
npm install
npx wrangler d1 create ghostrelay-db
# → Copy the database_id into wrangler.toml

npx wrangler d1 execute ghostrelay-db --local --file=../database/schema.sql
npx wrangler dev
# → http://localhost:8787
```

---

## Deployment

### Deploy Worker

```bash
cd worker
# Set production secret
npx wrangler secret put JWT_SECRET
# Deploy
npx wrangler deploy
```

### Deploy Frontend

**Vercel:**
```bash
cd frontend
npx vercel --prod
# Set NEXT_PUBLIC_API_URL in Vercel project settings
```

**Cloudflare Pages:**
```bash
cd frontend
npm run build
# Deploy .next/standalone or use CF Pages Git integration
```

---

## Environment Variables

### Frontend (.env.local)

| Variable                              | Description                          | Example                       |
|---------------------------------------|--------------------------------------|-------------------------------|
| NEXT_PUBLIC_API_URL                   | Worker API base URL                  | http://localhost:8787         |
| NEXT_PUBLIC_FIREBASE_API_KEY          | Firebase web API key                 | AIza...                       |
| NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN      | OAuth/consent domain (see below)     | auth.ghostrelay.me            |
| NEXT_PUBLIC_FIREBASE_PROJECT_ID       | Firebase project ID                  | ghostrelay-xxxxx              |
| NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET   | Firebase storage bucket              | ghostrelay-xxxxx.appspot.com  |
| NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID | Firebase messaging sender ID      | 1234567890                    |
| NEXT_PUBLIC_FIREBASE_APP_ID           | Firebase web app ID                  | 1:123:web:abc                 |

### Authentication (Google-only)

Sign-in is handled entirely by **Google via Firebase Authentication** — there is
no email/password login. The frontend calls `signInWithPopup`, and the Firebase
ID token is sent to the Worker as a Bearer token.

**Showing your own domain on the consent screen:** By default the Google sign-in
popup uses `<project>.firebaseapp.com` as the `authDomain`, which is visible in
the OAuth handler URL. To display your own app URL instead:

1. In the Firebase console, add your domain (e.g. `auth.ghostrelay.me`) under
   **Authentication → Settings → Authorized domains**.
2. Serve the Firebase auth handler on that domain (Firebase Hosting, or a reverse
   proxy to `/__/auth/handler`).
3. Set `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=auth.ghostrelay.me`.

Firebase Auth still runs behind the scenes — only the visible domain changes.

### Worker (wrangler.toml [vars] or secrets)

| Variable              | Description                                                  | Type   |
|-----------------------|--------------------------------------------------------------|--------|
| EMAIL_DOMAIN          | Domain for alias addresses                                   | var    |
| ORG_FORWARD_TO        | Inbox that receives org emails (support@)                    | var    |
| JWT_SECRET            | Token signing secret                                         | secret |
| CLOUDFLARE_ACCOUNT_ID | Account ID — enables free native forwarding                  | secret |
| CLOUDFLARE_API_TOKEN  | Token with Email Routing Addresses: Edit                     | secret |
| RESEND_API_KEY        | Fallback sender for unverified destinations + password resets | secret |
| DB                    | D1 database binding                                          | binding|

### Mail delivery paths

Alias mail is delivered by `message.forward()` — free, exempt from every
Cloudflare quota and daily send limit, with SPF/DKIM alignment preserved via ARC.
It only works for destination addresses verified on the Cloudflare account (cap:
200 per account), which is why signup and adding a destination both register the
inbox and trigger Cloudflare's verification email.

`RESEND_API_KEY` is a fallback for destinations that aren't verified yet, and the
sender for transactional mail (password resets). It is metered, so the goal is for
almost no alias traffic to reach it. See `docs/SETUP-FORWARDING.md`.

---

## Design Decisions

1. **Demo/Fallback mode**: The frontend gracefully falls back to localStorage when the backend is unreachable. This allows the UI to be previewed without any backend setup.

2. **Custom tokens over JWT**: Cloudflare Workers don't have native JWT libraries, so a simple HMAC-signed payload is used. The format is `base64(payload).base64(signature)`.

3. **SHA-256 password hashing**: Workers don't support bcrypt/argon2 natively. SHA-256 with a per-user salt is used as a pragmatic tradeoff.

4. **Optimistic UI updates**: Alias toggles and deletes update the UI immediately and revert on API failure.

5. **Free tier architecture**: The entire stack runs on Cloudflare's free tier (Workers, D1, Email Routing) plus a ~$10/year domain.

---

## Color Palette (Ghost Theme)

| Token                | Value           | Usage                    |
|----------------------|-----------------|--------------------------|
| --ghost-bg           | #0a0e1a         | Page background          |
| --ghost-surface      | #12182b         | Cards, panels            |
| --ghost-border       | #2a3563         | Borders, dividers        |
| --ghost-primary      | #7c3aed         | Buttons, accents         |
| --ghost-primary-light| #a78bfa         | Highlights, links        |
| --ghost-accent       | #06d6a0         | Success, active states   |
| --ghost-danger       | #f43f5e         | Errors, destructive      |
| --ghost-text         | #e8eaf6         | Primary text             |
| --ghost-text-muted   | #8892b0         | Secondary text           |

---

## Key Limits

- Free plan: 5 aliases max per user
- Token expiry: 7 days
- Alias format: 8 random alphanumeric chars + @domain
- Workers free tier: 100,000 requests/day
- D1 free tier: 5M rows read, 100K rows written per day
