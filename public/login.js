(() => {
  const status = document.getElementById('status');
  const error = document.getElementById('error');
  const loginBtn = document.getElementById('login');
  const logoutOld = document.getElementById('legacy');
  const params = new URLSearchParams(location.search);

  function showError(message) {
    status.textContent = 'Login setup needs attention';
    error.textContent = message;
    error.style.display = 'block';
  }

  async function start() {
    status.textContent = 'Connecting to secure Auth0 login…';
    try {
      const client = await GPP_AUTH0.init();
      if (await client.isAuthenticated()) {
        sessionStorage.removeItem('gpp_access_token');
        const token = await client.getTokenSilently();
        sessionStorage.setItem('gpp_access_token', token);
        location.replace('./index.html');
        return;
      }
      status.textContent = 'Sign in with Google or your username/password.';
      loginBtn.hidden = false;
      loginBtn.onclick = () => client.loginWithRedirect();
    } catch (e) {
      showError(e.message || String(e));
    }
  }

  if (params.has('error')) {
    showError(params.get('error_description') || params.get('error'));
    history.replaceState({}, document.title, location.pathname);
  } else if (params.has('code') && params.has('state')) {
    start().catch(e => showError(e.message));
  } else {
    start().catch(e => showError(e.message));
  }
})();
