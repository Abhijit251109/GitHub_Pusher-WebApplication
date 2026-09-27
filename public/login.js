(() => {
  const trimBase = value => String(value || '').trim().replace(/\/+$/, '');
  const configured = trimBase((window.GPP_CONFIG || {}).API_BASE || '');
  const saved = trimBase(sessionStorage.getItem('gpp_app_url') || localStorage.getItem('gpp_app_url') || configured);
  const status = document.getElementById('status');
  const setup = document.getElementById('setup');
  const input = document.getElementById('appUrl');
  const error = document.getElementById('error');
  const params = new URLSearchParams(location.search);
  const code = params.get('code');

  function validBase(base) {
    try { const u = new URL(base); return /^https?:$/.test(u.protocol); } catch { return false; }
  }
  function backendFromCurrentPage() {
    if (!location.hostname.endsWith('.github.io') && !location.hostname.endsWith('.githubusercontent.com')) return location.origin;
    return saved;
  }
  async function exchange(base) {
    if (!validBase(base)) throw new Error('Invalid backend URL.');
    sessionStorage.setItem('gpp_app_url', base);
    localStorage.setItem('gpp_app_url', base);
    const r = await fetch(`${base}/api/auth/exchange`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.token) throw new Error(data.error || `Login exchange failed (${r.status}).`);
    sessionStorage.setItem('gpp_access_token', data.token);
    location.replace('./index.html');
  }
  function begin(base) {
    base = trimBase(base);
    if (!validBase(base)) { error.textContent='Please enter a full URL starting with http:// or https://'; error.style.display='block'; return; }
    sessionStorage.setItem('gpp_app_url', base);
    localStorage.setItem('gpp_app_url', base);
    const returnTo = location.href.split('#')[0];
    location.href = `${base}/api/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  }

  if (code) {
    const base = backendFromCurrentPage();
    if (!base) { status.textContent = 'Enter your backend URL to finish sign-in.'; setup.classList.remove('hidden'); }
    else exchange(base).catch(err => { status.textContent='Login failed'; error.textContent=err.message; error.style.display='block'; setup.classList.remove('hidden'); });
    return;
  }
  const sameOriginBackend = backendFromCurrentPage();
  if (sameOriginBackend && validBase(sameOriginBackend)) { status.textContent = 'Opening secure GitHub authorization…'; begin(sameOriginBackend); return; }
  status.textContent = 'Backend address required'; setup.classList.remove('hidden'); if (saved) input.value = saved;
  document.getElementById('go').onclick = () => begin(input.value);
  document.getElementById('local').onclick = () => begin('http://127.0.0.1:4173');
})();
