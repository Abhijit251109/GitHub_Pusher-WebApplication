// Public GitHub Pages configuration.
//
// Public frontend configuration. Auth0 domain/client ID are served securely by the backend at /api/auth0/config.
// The Supabase publishable key is intentionally included in this browser bundle.
// Publishable keys are designed for client-side use and are NOT a replacement for
// the backend service-role key. Keep SUPABASE_SERVICE_ROLE_KEY only on Render.
//
// API_BASE can be overridden by changing this file for your deployment, e.g.:
//   API_BASE: 'https://your-app.onrender.com'
//
// SUPABASE_URL may be filled with your project URL if the frontend later uses the
// Supabase client directly. The current app continues to use the Render API for
// privileged operations.
window.GPP_CONFIG = Object.assign({
  // Render production API. Change this only if your Render service uses a different URL.
  API_BASE: 'https://github-project-pusher.onrender.com',
  SUPABASE_URL: 'https://vsrooptemnxxqolzbeze.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_DemHkA2PuMrqymIjUyFNJg_MYy1fFpo'
}, window.GPP_CONFIG || {});
