# AI integration validation

Validated using the repository's pinned Node 22.22.0:

- `npm run test:syntax`: passed.
- `npm test`: 86 passed, zero failed, zero skipped. Includes 15 AI provider/validation tests and 36 security tests covering the real HTTP server with mocked inference and Supabase.
- `node scripts/verify-project.mjs`: all 29 JavaScript files passed syntax verification.
- `git diff --check`: passed.
- Actual development server: startup, health, AI script delivery, and unauthenticated AI status rejection passed.
- Chromium browser checks with mocked API responses: selected-file proposal, before/after review, literal rendering of model text, explicit apply, unsaved editor draft protection, stale apply rejection, mobile layout at 390px, and cancelling proposals when switching projects passed.

No model weights or service credentials were supplied. Real Ollama inference, hosted-provider connectivity, real-model output quality, live GitHub OAuth, live Supabase persistence, and desktop/Android packaging were not validated. Existing integration tests exercise authentication and persistence through local mocks. Follow `AI_AGENT.md` to configure and test your chosen model with your deployment.

The source ZIP excludes installed dependencies, Git history, local runtime data, local secret files, and development logs. Install dependencies with `npm ci` after extraction.
