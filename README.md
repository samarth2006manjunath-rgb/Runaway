# Runway

Runway is a coursework dashboard with a real Blackboard Learn connection backend.

## Blackboard setup

1. Register a REST application in the [Blackboard Developer Portal](https://developer.blackboard.com/).
2. Ask the Blackboard administrator for each supported institution to install/approve that application. API access is limited by the entitlements assigned in Learn.
3. Set the application's redirect URI to `https://YOUR_RUNWAY_HOST/api/blackboard/callback`.
4. Copy `.env.example` to `.env` and fill in the application key, secret, public origin, and a random encryption key.
5. Start with `npm start`.

The Settings screen accepts the institution's real Learn hostname. Authorization happens on the institution's Blackboard page. Runway exchanges the returned authorization code on the server, encrypts tokens at rest with AES-256-GCM, and syncs the authorized user's profile, memberships, courses, top-level course content, announcements, gradebook columns, and grades.

## API

- `GET /api/blackboard/status` — public connection metadata only
- `POST /api/blackboard/connect` — validate a Learn hostname and create an OAuth authorization URL
- `GET /api/blackboard/callback` — exchange Blackboard's authorization code and run the first sync
- `POST /api/blackboard/sync` — refresh data from Learn
- `GET /api/blackboard/data` — return the latest server-side snapshot
- `DELETE /api/blackboard/connection` — remove the saved connection and tokens

## Deploying

This is now a Node service, not a static-only site. Deploy it to a host with persistent writable storage for `data/` (or replace `ConnectionStore` with a managed database), set the environment variables, and run `npm start`. Static-only hosts such as GitHub Pages cannot run the Blackboard backend.

For a multi-user production launch, replace the single encrypted connection file with per-user records tied to your authentication system and add authorization checks to every `/api/blackboard/*` route.
