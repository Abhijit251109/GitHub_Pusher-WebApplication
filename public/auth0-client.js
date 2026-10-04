(() => {
  const config = window.GPP_CONFIG || {};
  const trimBase = value => String(value || '').trim().replace(/\/+$/, '');
  const configured = trimBase(config.API_BASE || '');
  const isPagesHost = /(^|\.)github\.io$/.test(location.hostname) || /(^|\.)githubusercontent\.com$/.test(location.hostname);
  const stored = trimBase(sessionStorage.getItem('gpp_app_url') || localStorage.getItem('gpp_app_url') || '');
  const API_BASE = trimBase(isPagesHost ? (configured || stored) : (stored || configured)) || location.origin;
  const apiUrl = path => new URL(path.replace(/^\/+/, ''), API_BASE.replace(/\/+$/, '') + '/').toString();
  let client = null;

  async function loadSdk() {
    if (window.auth0?.createAuth0Client) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.auth0.com/js/auth0-spa-js/2.9/auth0-spa-js.production.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Auth0 SDK could not be loaded. Check your network or Content-Security-Policy settings.'));
      document.head.appendChild(script);
    });
  }

  async function init() {
    await loadSdk();
    const response = await fetch(apiUrl('/api/auth0/config'), { headers: { Accept: 'application/json' } });
    const cfg = await response.json().catch(() => ({}));
    if (!response.ok || !cfg.enabled) throw new Error(cfg.error || 'Auth0 is not configured on the backend.');
    const redirectUri = `${location.origin}${location.pathname}`;
    client = await window.auth0.createAuth0Client({
      domain: cfg.domain,
      clientId: cfg.clientId,
      cacheLocation: 'localstorage',
      useRefreshTokens: true,
      authorizationParams: {
        redirect_uri: redirectUri,
        audience: cfg.audience,
        scope: 'openid profile email'
      }
    });
    if (location.search.includes('code=') && location.search.includes('state=')) {
      await client.handleRedirectCallback();
      history.replaceState({}, document.title, location.pathname);
    }
    return client;
  }

  async function getAccessToken() {
    if (!client) await init();
    return client.getTokenSilently();
  }
  async function isAuthenticated() {
    if (!client) await init();
    return client.isAuthenticated();
  }
  async function getUser() {
    if (!client) await init();
    return client.getUser();
  }
  function login() { return client.loginWithRedirect(); }
  function logout() {
    const returnTo = `${location.origin}${location.pathname.replace(/\/login\.html$/, '/index.html')}`;
    return client.logout({ logoutParams: { returnTo } });
  }

  window.GPP_AUTH0 = { init, getAccessToken, isAuthenticated, getUser, login, logout, apiUrl, get client() { return client; } };
})();
