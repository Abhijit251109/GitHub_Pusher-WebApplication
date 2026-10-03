(() => {
  const CONFIG = window.GPP_CONFIG || {};
  const trimBase = value => String(value || '').trim().replace(/\/+$/, '');
  const isPages = /(^|\.)github\.io$/.test(location.hostname) || /(^|\.)githubusercontent\.com$/.test(location.hostname);
  const configured = trimBase(CONFIG.API_BASE || '');
  const stored = trimBase(sessionStorage.getItem('gpp_app_url') || localStorage.getItem('gpp_app_url') || '');
  const API_BASE = trimBase(isPages ? (configured || stored) : (stored || configured));
  const API_ORIGIN = API_BASE || location.origin;
  const apiUrl = path => new URL(path.replace(/^\/+/, ''), API_ORIGIN.replace(/\/+$/, '') + '/').toString();
  const token = () => sessionStorage.getItem('gpp_access_token') || '';
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  async function loadContact() {
    try {
      const response = await fetch(apiUrl('/api/public/contact'), { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      const github = data.githubUrl || CONFIG.PUBLIC_GITHUB_URL || '';
      const email = data.email || CONFIG.PUBLIC_CONTACT_EMAIL || '';
      document.querySelectorAll('[data-contact-github]').forEach(el => {
        if (!github) { el.hidden = true; return; }
        el.hidden = false;
        el.textContent = github.replace(/^https?:\/\//, '');
        if (el.tagName === 'A') el.href = github;
      });
      document.querySelectorAll('[data-contact-email]').forEach(el => {
        if (!email) { el.hidden = true; return; }
        el.hidden = false;
        el.textContent = email;
        if (el.tagName === 'A') el.href = `mailto:${email}`;
      });
      document.querySelectorAll('[data-contact-empty]').forEach(el => {
        el.hidden = Boolean(github || email);
      });
    } catch {}
  }

  function open(id) { const dialog = $(id); if (dialog && typeof dialog.showModal === 'function') dialog.showModal(); }
  function closeForm(form) { const dialog = form?.closest('dialog'); if (dialog) dialog.close(); }
  async function submitForm(form, endpoint) {
    const status = form.querySelector('.form-status');
    const button = form.querySelector('[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    status.textContent = 'Sending…';
    status.className = 'form-status';
    button.disabled = true;
    try {
      const headers = {'Content-Type':'application/json'};
      const accessToken = token();
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const response = await fetch(apiUrl(endpoint), { method:'POST', credentials:'include', headers, body: JSON.stringify(data) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      status.textContent = endpoint.includes('feedback') ? 'Thanks — your feedback was saved.' : 'Thanks — your contribution was saved.';
      status.className = 'form-status success';
      form.reset();
      setTimeout(() => closeForm(form), 900);
    } catch (error) {
      status.textContent = error.message;
      status.className = 'form-status error';
    } finally { button.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadContact();
    document.querySelectorAll('[data-open-feedback]').forEach(btn => btn.onclick = () => open('feedbackDialog'));
    document.querySelectorAll('[data-open-contribute]').forEach(btn => btn.onclick = () => open('contributeDialog'));
    document.querySelectorAll('[data-close-dialog]').forEach(btn => btn.onclick = () => btn.closest('dialog')?.close());
    const feedbackForm = $('feedbackForm');
    const contributeForm = $('contributeForm');
    if (feedbackForm) feedbackForm.addEventListener('submit', event => { event.preventDefault(); submitForm(feedbackForm, '/api/feedback'); });
    if (contributeForm) contributeForm.addEventListener('submit', event => { event.preventDefault(); submitForm(contributeForm, '/api/contribute'); });
    document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    }));
  });
})();
