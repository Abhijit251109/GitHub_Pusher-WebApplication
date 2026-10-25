// AI proposals stay in this tab until the user explicitly applies an individual file.
(() => {
  const context = () => window.projectEditor.getAIContext();
  let projectId = null;
  let paths = [];
  let changes = [];
  let enabled = false;
  let controller = null;
  let applying = false;
  let statusVersion = 0;
  const status = message => { $('aiStatus').textContent = message; };

  function controls() {
    const current = context();
    const locked = Boolean(controller) || applying || current.busy;
    $('aiFileCount').textContent = `${paths.length} / 6`;
    $('aiAttachFile').disabled = locked || !current.path || current.dirty || paths.includes(current.path) || paths.length >= 6;
    $('aiClearFiles').disabled = locked || !paths.length;
    $('aiGenerate').disabled = locked || current.dirty || !enabled || !paths.length || !$('aiInstruction').value.trim();
    $('aiInstruction').disabled = locked;
    $('aiCancel').hidden = !controller;
    $('aiDiscardAll').hidden = !changes.length;
    $('aiDiscardAll').disabled = locked;
    for (const button of $('aiFiles').querySelectorAll('button')) button.disabled = locked;
    for (const button of $('aiChanges').querySelectorAll('button')) {
      button.disabled = locked || Boolean(button.dataset.done) || (button.dataset.apply === 'true' && current.dirty);
    }
    $('aiAgent').setAttribute('aria-busy', String(Boolean(controller) || applying));
  }

  function discard() {
    changes = [];
    $('aiChanges').replaceChildren();
    $('aiSummary').textContent = '';
    $('aiReview').hidden = true;
    controls();
  }

  function renderFiles() {
    $('aiFiles').replaceChildren();
    for (const path of paths) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = path;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${path} from AI context`);
      remove.onclick = () => { paths = paths.filter(p => p !== path); discard(); renderFiles(); };
      item.append(name, remove);
      $('aiFiles').append(item);
    }
    controls();
  }

  async function checkStatus() {
    const version = ++statusVersion;
    enabled = false;
    controls();
    $('aiProviderStatus').textContent = 'Checking configuration…';
    try {
      const result = await api('/api/ai/status');
      if (version !== statusVersion) return;
      enabled = result.enabled;
      $('aiProviderStatus').textContent = enabled
        ? `Configured model: ${result.model}. A request will check availability.`
        : 'AI is disabled. Configure the server using docs/AI_AGENT.md to enable it.';
    } catch (error) {
      if (version === statusVersion) $('aiProviderStatus').textContent = error.message;
    } finally { if (version === statusVersion) controls(); }
  }

  function renderProposal(result, id) {
    changes = result.changes;
    $('aiSummary').textContent = result.summary;
    $('aiChanges').replaceChildren();
    $('aiReview').hidden = false;
    for (const change of changes) {
      const card = document.createElement('article');
      card.className = 'ai-change';
      const heading = document.createElement('h4');
      heading.textContent = change.path;
      const explanation = document.createElement('p');
      explanation.textContent = change.explanation;
      const comparison = document.createElement('div');
      comparison.className = 'ai-comparison';
      for (const [label, contents] of [['Before', change.originalContent], ['Proposed replacement', change.content]]) {
        const column = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = label;
        const pre = document.createElement('pre');
        pre.tabIndex = 0;
        pre.setAttribute('aria-label', `${label}: ${change.path}`);
        pre.textContent = contents || '(empty file)';
        column.append(title, pre);
        comparison.append(column);
      }
      const actions = document.createElement('div');
      actions.className = 'ai-actions';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'primary';
      apply.dataset.apply = 'true';
      apply.textContent = 'Apply edit';
      apply.setAttribute('aria-label', `Apply edit to ${change.path}`);
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'ghost';
      reject.textContent = 'Discard';
      reject.setAttribute('aria-label', `Discard edit to ${change.path}`);
      const outcome = document.createElement('p');
      outcome.setAttribute('role', 'status');
      apply.onclick = async () => {
        if (projectId !== id || applying || controller) return;
        applying = true;
        controls();
        try {
          await window.projectEditor.applyAIChange(id, change);
          apply.dataset.done = reject.dataset.done = 'true';
          apply.textContent = 'Applied';
          outcome.textContent = 'Saved to your app workspace. Test the change before pushing.';
        } catch (error) {
          outcome.textContent = error.code === 'FILE_CHANGED'
            ? 'This file changed after the proposal was created. Generate a new proposal to review its latest version.'
            : error.message;
          if (error.code === 'FILE_CHANGED') apply.dataset.done = 'true';
        } finally { applying = false; controls(); }
      };
      reject.onclick = () => {
        apply.dataset.done = reject.dataset.done = 'true';
        outcome.textContent = 'Discarded. No file changes were applied.';
        controls();
      };
      actions.append(apply, reject);
      card.append(heading, explanation, comparison, actions, outcome);
      $('aiChanges').append(card);
    }
    controls();
    $('aiReviewHeading').focus();
  }

  $('aiAttachFile').onclick = () => {
    const current = context();
    if (!current.path || current.dirty || current.busy || paths.includes(current.path) || paths.length >= 6) return;
    paths.push(current.path);
    discard();
    renderFiles();
  };
  $('aiClearFiles').onclick = () => { paths = []; discard(); renderFiles(); };
  $('aiInstruction').addEventListener('input', controls);
  $('aiCheckStatus').onclick = checkStatus;
  $('aiCancel').onclick = () => controller?.abort();
  $('aiDiscardAll').onclick = () => { discard(); status('Proposals discarded. Applied changes remain in your workspace.'); };
  $('aiGenerate').onclick = async () => {
    if (!projectId || controller || applying || !window.projectEditor.requireSaved(projectId)) return;
    const id = projectId;
    const request = new AbortController();
    controller = request;
    discard();
    controls();
    status('Preparing a proposal from the selected saved files…');
    try {
      const result = await api(`/api/projects/${id}/ai/propose`, {
        method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: $('aiInstruction').value.trim(), paths: [...paths] })
      });
      if (projectId !== id || controller !== request || request.signal.aborted) return;
      renderProposal(result, id);
      status(result.changes.length ? 'Review each replacement below. Apply only the changes you want.' : 'The model proposed no file changes. See its summary below.');
    } catch (error) {
      if (projectId === id && controller === request) status(error.name === 'AbortError' ? 'Request cancelled. No edits were applied.' : error.message);
    } finally {
      if (controller === request) { controller = null; controls(); }
    }
  };
  document.addEventListener('project-editor-change', () => {
    const current = context();
    if (current.projectId !== projectId) {
      controller?.abort();
      controller = null;
      statusVersion++;
      projectId = current.projectId;
      paths = [];
      $('aiInstruction').value = '';
      discard();
      renderFiles();
      status('Attach saved files, describe a change, then review the proposal.');
      if (projectId) checkStatus();
    }
    controls();
  });
})();
