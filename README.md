# Runway

Runway is a coursework dashboard with a real Blackboard Learn connection backend.

## Google Calendar setup

1. In Google Cloud Console, create or select a project and enable the Google Calendar API.
2. Configure the OAuth consent screen and create a **Web application** OAuth client.
3. Add `https://YOUR_RUNWAY_HOST/api/google-calendar/callback` as an authorized redirect URI (use `http://localhost:3000/api/google-calendar/callback` for local development).
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ORIGIN`, and `TOKEN_ENCRYPTION_KEY` in the environment.
5. Open Runway Settings and choose **Connect Google Calendar**.

Runway requests only `calendar.readonly`. OAuth runs on Google's page, access and refresh tokens are encrypted at rest, and synchronized events appear in the Today/Week calendar without allowing Runway to edit or delete Google events.

## Blackboard setup

1. Register a REST application in the [Blackboard Developer Portal](https://developer.blackboard.com/).
2. Ask the Blackboard administrator for each supported institution to install/approve that application. API access is limited by the entitlements assigned in Learn.
3. Set the application's redirect URI to `https://YOUR_RUNWAY_HOST/api/blackboard/callback`.
4. Copy `.env.example` to `.env` and fill in the application key, secret, public origin, and a random encryption key.
5. Start with `npm start`.

The Settings screen accepts the institution's real Learn hostname. Authorization happens on the institution's Blackboard page. Runway exchanges the returned authorization code on the server, encrypts tokens at rest with AES-256-GCM, and syncs the authorized user's profile, memberships, courses, top-level course content, announcements, gradebook columns, and grades.

## API

### Google Calendar

- `GET /api/google-calendar/status` — connection metadata only
- `POST /api/google-calendar/connect` — create a Google OAuth authorization URL
- `GET /api/google-calendar/callback` — exchange the authorization code and run the first sync
- `POST /api/google-calendar/sync` — refresh calendars and events
- `GET /api/google-calendar/data` — return the latest server-side snapshot
- `DELETE /api/google-calendar/connection` — remove the saved connection and tokens

### Blackboard

- `GET /api/blackboard/status` — public connection metadata only
- `POST /api/blackboard/connect` — validate a Learn hostname and create an OAuth authorization URL
- `GET /api/blackboard/callback` — exchange Blackboard's authorization code and run the first sync
- `POST /api/blackboard/sync` — refresh data from Learn
- `GET /api/blackboard/data` — return the latest server-side snapshot
- `DELETE /api/blackboard/connection` — remove the saved connection and tokens

## Deploying

This is now a Node service, not a static-only site. Deploy it to a host with persistent writable storage for `data/` (or replace `ConnectionStore` with a managed database), set the environment variables, and run `npm start`. Static-only hosts such as GitHub Pages cannot run the Blackboard backend.

For a multi-user production launch, replace the single encrypted connection file with per-user records tied to your authentication system and add authorization checks to every `/api/blackboard/*` route.
