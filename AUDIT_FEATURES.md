# Feature audit

- **Feedback:** `public/feedback.js` submits to `POST /api/feedback`; the backend writes a local `.txt` record and, when Supabase is configured, mirrors it to the private storage bucket.
- **Contribute:** `public/feedback.js` submits to `POST /api/contribute`; the backend writes a local `.json` record and mirrors it to Supabase storage when configured.
- **Themes:** System / Dark / Light, persisted in `localStorage`, with system-theme change handling.
- **Cross-device uploads:** uploads use an EXDEV-safe move (`rename`, then `copyFile` + remove) for Render filesystem boundaries.
- **Persistence:** project archives and snapshots are stored in private Supabase Storage with metadata in Postgres.
- **GitHub:** OAuth uses PKCE/state binding; push, pull/sync, and snapshot flows remain in the backend.
- **Live status:** SSE reconnects use a short-lived reusable ticket so EventSource reconnects do not fail after the first connection.
- **PWA:** `public/sw.js` caches the shell but leaves API requests network-only.
- **Native apps:** Electron and Capacitor default to the production hosted backend and support `GPP_APP_URL` overrides.
