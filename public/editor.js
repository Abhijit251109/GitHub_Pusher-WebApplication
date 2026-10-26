// Uses the existing authenticated API and stored project workspace; never commits automatically.
(() => {
  let projectId = null;
  let project = null;
  let folder = '';
  let file = null;
  let activeBranch = '';
  let busy = false;
  const area = $('codeEditor');
  const lineNumbers = $('lineNumbers');
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
    $('editorBranchSelect').disabled = busy;
    $('editorSwitchBranch').disabled = busy || $('editorBranchSelect').value === activeBranch;
    area.readOnly = busy;
  }

  async function task(action) {
    if (busy) { toast('Wait for the editor to finish its current operation.'); return false; }
    busy = true;
    $('workspaceEditor').setAttribute('aria-busy', 'true');
    updateControls();
    try { await action(); return true; }
    catch (e) {
      $('editorStatus').textContent = e.message;
      toast(e.message);
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
    $('codeEditorWrap').hidden = true;
    $('editorFileName').textContent = 'Select a file';
    $('editorStatus').textContent = 'Open a text file to start editing. Binary files and files over 2 MiB are kept unchanged.';
    $('editorPosition').textContent = 'UTF-8';
    lineNumbers.textContent = '1';
    lineNumbers.scrollTop = 0;
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
    $('codeEditorWrap').hidden = false;
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

  async function openProject(selectedProject) {
    if (busy || !mayDiscard()) return;
    project = { ...selectedProject };
    projectId = project.id;
    activeBranch = project.branch || '';
    folder = '';
    resetFile();
    $('editorProjectName').textContent = project.name;
    $('workspaceEditor').hidden = false;
    $('editorBranchControl').hidden = !project.repoId;
    $('editorSwitchBranch').hidden = !project.repoId;
    await task(async () => {
      if (project.repoId) {
        try { await loadBranches(project.repoId, activeBranch); }
        catch (error) {
          $('editorBranchSelect').replaceChildren(new Option(`${activeBranch} (branch list unavailable)`, activeBranch));
          $('editorBranchSelect').value = activeBranch;
          toast(`Could not load branches: ${error.message}`);
        }
      } else $('editorBranchSelect').replaceChildren();
      await listFolder('');
    });
    $('workspaceEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadBranches(repoId, selectedBranch) {
    const data = await api(`/api/github/branches?repoId=${encodeURIComponent(repoId)}`);
    const select = $('editorBranchSelect');
    select.replaceChildren();
    for (const branch of data.branches) {
      const option = document.createElement('option');
      option.value = branch.name;
      option.textContent = branch.name;
      select.append(option);
    }
    if (selectedBranch && !data.branches.some(branch => branch.name === selectedBranch)) {
      const option = document.createElement('option');
      option.value = selectedBranch;
      option.textContent = `${selectedBranch} (current; unavailable)`;
      select.append(option);
    }
    select.value = selectedBranch || data.defaultBranch;
    activeBranch = select.value;
    project.branch = activeBranch;
    updateControls();
  }

  async function switchBranch() {
    if (!projectId || !project?.repoId || busy || !mayDiscard()) return;
    const branch = $('editorBranchSelect').value;
    if (!branch || branch === activeBranch) return;
    if (!confirm(`Switch from "${activeBranch}" to "${branch}"? This replaces the app workspace with that branch. A safety snapshot will be saved first.`)) return;
    await task(async () => {
      const result = await api('/api/github/switch-branch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, branch })
      });
      project = result.project;
      activeBranch = result.project.branch;
      folder = '';
      resetFile();
      await listFolder('');
      historyCache.delete(projectId);
      await loadBranches(project.repoId, activeBranch).catch(error => toast(`Switched branches, but could not refresh the branch list: ${error.message}`));
      await refresh().catch(error => toast(`Branch switched, but project details could not refresh: ${error.message}`));
      toast(`Switched to branch ${activeBranch}.`);
    });
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
    let lineCount = 1;
    for (const character of area.value) if (character === '\n') lineCount++;
    lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
  }

  area.oninput = () => { updateControls(); updatePosition(); };
  area.onscroll = () => { lineNumbers.scrollTop = area.scrollTop; };
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
  $('editorSwitchBranch').onclick = switchBranch;
  $('editorBranchSelect').onchange = updateControls;
  $('editorReload').onclick = () => { if (mayDiscard()) task(reload); };
  $('folderUp').onclick = () => task(() => listFolder(folder.split('/').slice(0, -1).join('/')));
  $('folderRoot').onclick = () => task(() => listFolder(''));
  $('editorClose').onclick = () => {
    if (busy || !mayDiscard()) return;
    resetFile();
    projectId = null;
    project = null;
    activeBranch = '';
    $('workspaceEditor').hidden = true;
    $('editorBranchControl').hidden = true;
    $('editorSwitchBranch').hidden = true;
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
    async refreshBranches(id) {
      if (projectId !== id || !project?.repoId || busy) return;
      await task(() => loadBranches(project.repoId, activeBranch));
    },
    prepareLeave() { if (busy) return false; return mayDiscard(); },
    selectionChanged(id) {
      if (!projectId || projectId === id) return;
      resetFile();
      projectId = null;
      project = null;
      activeBranch = '';
      $('workspaceEditor').hidden = true;
      $('editorBranchControl').hidden = true;
      $('editorSwitchBranch').hidden = true;
    }
  };
})();
