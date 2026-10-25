// Uses the existing authenticated API and stored project workspace; never commits automatically.
(() => {
  let projectId = null;
  let folder = '';
  let file = null;
  let busy = false;
  const area = $('codeEditor');
  const normalized = text => text.replace(/\r\n?/g, '\n');
  const dirty = () => Boolean(file && area.value !== normalized(file.content));
  const mayDiscard = () => !dirty() || confirm('Discard the unsaved edits in this file? Save first to keep them.');

  function updateControls() {
    $('editorDirty').hidden = !dirty();
    $('editorSave').disabled = busy || !dirty();
    $('editorReload').disabled = busy;
    $('editorClose').disabled = busy;
    $('folderUp').disabled = busy || !folder;
    $('folderRoot').disabled = busy || !folder;
    area.readOnly = busy;
    document.dispatchEvent(new CustomEvent('project-editor-change'));
  }

  async function task(action, { rethrow = false } = {}) {
    if (busy) { toast('Wait for the editor to finish its current operation.'); return false; }
    busy = true;
    $('workspaceEditor').setAttribute('aria-busy', 'true');
    updateControls();
    try { await action(); return true; }
    catch (e) {
      $('editorStatus').textContent = e.message;
      toast(e.message);
      if (rethrow) throw e;
      return false;
    } finally {
      busy = false;
      $('workspaceEditor').removeAttribute('aria-busy');
      updateControls();
    }
  }

  function resetFile() {
    file = null;
    area.value = '';
    area.hidden = true;
    $('editorFileName').textContent = 'Select a file';
    $('editorStatus').textContent = 'Open a text file to start editing. Binary files and files over 2 MiB are kept unchanged.';
    $('editorPosition').textContent = 'UTF-8';
    updateControls();
  }

  async function listFolder(relative) {
    const data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relative)}`);
    folder = data.path;
    $('folderPath').textContent = folder || '/';
    const container = $('fileList');
    container.replaceChildren();
    if (!data.entries.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'This folder is empty.';
      container.append(empty);
    }
    for (const entry of data.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-entry';
      button.dataset.path = entry.path;
      const name = document.createElement('span');
      name.textContent = `${entry.type === 'directory' ? '▸ 📁' : '·'} ${entry.name}`;
      button.append(name);
      if (entry.type === 'file') {
        const size = document.createElement('small');
        size.textContent = formatBytes(entry.size);
        button.append(size);
      }
      button.title = entry.path;
      button.onclick = () => {
        if (busy) return;
        if (entry.type === 'directory') task(() => listFolder(entry.path));
        else if (mayDiscard()) task(() => openFile(entry.path));
      };
      container.append(button);
    }
    highlightFile();
  }

  function highlightFile() {
    for (const button of $('fileList').querySelectorAll('.file-entry')) {
      button.setAttribute('aria-current', button.dataset.path === file?.path ? 'true' : 'false');
    }
  }

  async function openFile(relative) {
    // Keep the current draft if the requested file is unreadable or the request fails.
    const data = await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(relative)}`);
    file = data;
    area.value = normalized(data.content);
    area.hidden = false;
    $('editorFileName').textContent = data.path;
    $('editorStatus').textContent = `${formatBytes(data.size)} · UTF-8 · Save updates your app workspace. Push Selected publishes to GitHub.`;
    highlightFile();
    updatePosition();
  }

  async function reload() {
    const previous = file?.path;
    await listFolder(folder);
    if (previous) {
      // Unsaved drafts have been explicitly discarded by the caller.
      resetFile();
      await openFile(previous);
    }
  }

  async function openProject(project) {
    if (busy || !mayDiscard()) return;
    projectId = project.id;
    folder = '';
    resetFile();
    $('editorProjectName').textContent = project.name;
    $('workspaceEditor').hidden = false;
    await task(() => listFolder(''));
    $('workspaceEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function save() {
    if (busy || !dirty()) return;
    await task(async () => {
      // Textareas normalize newlines. Retain the original file's CRLF/CR convention.
      const eol = /\r\n/.test(file.content) && !/(^|[^\r])\n/.test(file.content) ? '\r\n' : /\r/.test(file.content) && !/\n/.test(file.content) ? '\r' : '\n';
      const content = area.value.replace(/\n/g, eol);
      const result = await api(`/api/projects/${projectId}/file`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, content, sha: file.sha })
      });
      file = result;
      $('editorStatus').textContent = result.changed ? 'Saved to your app workspace. Fetch Changes to check GitHub, then Push Selected when ready.' : 'No changes to save.';
      historyCache.delete(projectId);
      await refresh().catch(e => toast(`File saved. Project refresh failed: ${e.message}`));
      await listFolder(folder);
      toast('File saved.');
    });
  }

  function updatePosition() {
    const before = area.value.slice(0, area.selectionStart);
    const lines = before.split('\n');
    $('editorPosition').textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1} · UTF-8`;
  }

  area.oninput = () => { updateControls(); updatePosition(); };
  area.addEventListener('click', updatePosition);
  area.addEventListener('keyup', updatePosition);
  area.addEventListener('keydown', event => {
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      if (busy) return;
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      updateControls();
      updatePosition();
    }
  });
  $('editorSave').onclick = save;
  $('editorReload').onclick = () => { if (mayDiscard()) task(reload); };
  $('folderUp').onclick = () => task(() => listFolder(folder.split('/').slice(0, -1).join('/')));
  $('folderRoot').onclick = () => task(() => listFolder(''));
  $('editorClose').onclick = () => {
    if (busy || !mayDiscard()) return;
    resetFile();
    projectId = null;
    $('workspaceEditor').hidden = true;
    updateControls();
  };
  window.addEventListener('beforeunload', event => {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('keydown', event => {
    if (!projectId || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    save();
  });
  window.projectEditor = {
    openProject,
    getAIContext() { return { projectId, path: file?.path || null, dirty: dirty(), busy }; },
    async applyAIChange(id, change) {
      if (projectId !== id) throw new Error('Open the project again before applying this change.');
      if (busy) throw new Error('Wait for the editor to finish its current operation.');
      if (dirty()) throw new Error('Save or discard your editor draft before applying an AI edit.');
      let result;
      await task(async () => {
        result = await api(`/api/projects/${id}/file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: change.path, content: change.content, sha: change.sha })
        });
        if (file?.path === change.path) {
          file = result;
          area.value = normalized(result.content);
          updatePosition();
        }
        $('editorStatus').textContent = 'AI edit saved to your app workspace. Review and test it, then Push Selected when ready.';
        historyCache.delete(id);
        // A refresh failure must not report that the already-persisted edit failed.
        await refresh().catch(e => toast(`Edit saved. Project refresh failed: ${e.message}`));
        await listFolder(folder).catch(e => toast(`Edit saved. File list refresh failed: ${e.message}`));
      }, { rethrow: true });
      return result;
    },
    requireSaved(id) {
      if (!projectId || projectId !== id) return true;
      if (busy) { toast('Wait for the editor to finish its current operation.'); return false; }
      if (dirty()) { toast('Save your file or discard the draft before fetching or pushing.'); return false; }
      return true;
    },
    async reloadAfterSync(id) {
      if (projectId !== id || dirty()) return;
      await task(reload);
    },
    prepareLeave() { if (busy) return false; return mayDiscard(); },
    selectionChanged(id) {
      if (!projectId || projectId === id) return;
      resetFile();
      projectId = null;
      $('workspaceEditor').hidden = true;
      updateControls();
    }
  };
})();
