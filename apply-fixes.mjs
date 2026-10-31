import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const gitNullDevice = process.platform === 'win32' ? 'NUL' : os.devNull;
const targetFiles = ['server.js', 'public/app.js', 'public/index.html', 'package.json'];
for (const file of targetFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error('Run this script from the GitHub_Pusher-WebApplication project root. Missing: ' + file);
    process.exit(1);
  }
}

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error('Could not find the expected source block: ' + label + '. No files were changed.');
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error('The source block was not unique: ' + label + '. No files were changed.');
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

let server = read('server.js');
let app = read('public/app.js');
let html = read('public/index.html');
const packageJson = JSON.parse(read('package.json'));

if (server.includes('function throwIfAborted(signal)') && app.includes('function cancelPush()')) {
  console.log('The push/cancel fix already appears to be installed. No files changed.');
  process.exit(0);
}

app = replaceOnce(app,
  'let projects=[];let selectedId=null;',
  'let projects=[];let selectedId=null;let pushAbortController=null;',
  'push cancellation state');
app = replaceOnce(app,
  'async function openPush(){const p=projects.find(x=>x.id===selectedId);',
  "async function openPush(){if(pushAbortController){toast('A previous push is still stopping. Please wait a moment.');return}const p=projects.find(x=>x.id===selectedId);",
  'prevent overlapping push attempts');
const pushStart = app.indexOf('async function push(){');
const pushEnd = app.indexOf('\nasync function removeProject()', pushStart);
if (pushStart < 0 || pushEnd < 0) throw new Error('Could not locate the push() function. No files were changed.');
const pushFn = String.raw`async function push(){
 const p=projects.find(x=>x.id===selectedId);
 if(!p)return;
 if(pushAbortController){toast('A previous push is still stopping. Please wait a moment.');return}
 if($('repoSelect').disabled){toast('Please wait for the GitHub repository list to finish loading.');return}
 const body={projectId:p.id,repoId:$('repoSelect').value||null,repoName:$('newRepoName').value,visibility:$('visibility').value,branch:$('branch').value.trim()||'main'};
 const controller=new AbortController();
 pushAbortController=controller;
 const cancelButton=$('cancelPush');
 const progress=$('pushProgress');
 if(cancelButton){cancelButton.textContent='Cancel push';cancelButton.disabled=false}
 if(progress){progress.hidden=false;progress.textContent='Pushing to GitHub… Cancelling stops ongoing Git work where possible; changes already accepted by GitHub cannot be rolled back automatically.'}
 try{
  await withBusy($('confirmPush'),'Pushing…',async()=>{
   const r=await api('/api/github/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
   historyCache.delete(p.id);
   toast('Pushed to '+r.repo.full_name);
   $('pushDialog').close('success');
   await refresh();
  })
 }catch(e){
  if(controller.signal.aborted||e?.name==='AbortError')toast('Push cancelled. Any changes already accepted by GitHub cannot be rolled back automatically.');
  else toast(e.message||'Push failed. Please retry and check the project status.');
 }finally{
  if(pushAbortController===controller){
   pushAbortController=null;
   if(cancelButton){cancelButton.textContent='Cancel';cancelButton.disabled=false}
   if(progress)progress.hidden=true;
  }
 }
}
function cancelPush(){
 const dialog=$('pushDialog');
 if(pushAbortController&&!pushAbortController.signal.aborted){
  pushAbortController.abort();
  toast('Stopping the push… already-uploaded GitHub changes cannot be automatically undone.');
 }
 if(dialog?.open)dialog.close('cancel');
}`;
app = app.slice(0, pushStart) + pushFn + app.slice(pushEnd);
const oldHandlers = "$('addBtn').onclick=()=>$('addDialog').showModal();$('addForm').onsubmit=e=>{e.preventDefault();addProject()};$('pushBtn').onclick=openPush;$('pushForm').onsubmit=e=>{e.preventDefault();push()};";
const newHandlers = String.raw`$('addBtn').onclick=()=>$('addDialog').showModal();
$('addForm').onsubmit=e=>{e.preventDefault();if(e.submitter?.value==='cancel'){$('addDialog').close('cancel');return}addProject()};
$('pushBtn').onclick=openPush;
$('pushForm').onsubmit=e=>{e.preventDefault();if(e.submitter?.value==='cancel'){cancelPush();return}push()};
$('pushDialog').addEventListener('cancel',e=>{if(pushAbortController&&!pushAbortController.signal.aborted){e.preventDefault();cancelPush()}});`;
app = replaceOnce(app, oldHandlers, newHandlers, 'dialog cancel handlers');

html = replaceOnce(html,
  '<button class="ghost" value="cancel">Cancel</button><button id="saveProject"',
  '<button class="ghost" id="cancelAdd" value="cancel" formnovalidate>Cancel</button><button id="saveProject"',
  'add-project cancel button');
html = replaceOnce(html,
  '<div class="warning">A selected repository with unrelated existing history may require a manual merge. The app will not force-push over it.</div><div class="dialog-actions"><button class="ghost" value="cancel">Cancel</button><button id="confirmPush"',
  '<div class="warning">A selected repository with unrelated existing history may require a manual merge. The app will not force-push over it.</div><div id="pushProgress" class="muted" role="status" aria-live="polite" hidden></div><div class="dialog-actions"><button class="ghost" id="cancelPush" value="cancel" formnovalidate>Cancel</button><button id="confirmPush"',
  'push cancel button and progress status');

const helperStart = server.indexOf('async function sanitizeGitRepository(dir) {');
const helperEnd = server.indexOf('\nfunction applicationFileInfo', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Could not locate the Git helper functions. No files were changed.');
const helperBlock = String.raw`function throwIfAborted(signal){
 if(!signal?.aborted)return;
 const error=new Error('Push cancelled by user.');
 error.name='AbortError';
 throw error;
}
function isValidGitBranch(branch){
 if(typeof branch!=='string'||!branch||branch.length>200)return false;
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))return false;
 if(branch.includes('..')||branch.includes('//')||branch.includes('@{')||branch.endsWith('/')||branch.endsWith('.'))return false;
 return branch.split('/').every(part=>part&&!part.startsWith('.')&&!part.endsWith('.lock'));
}
function formatPushError(error){
 const details=String(error?.stderr||error?.message||'Push failed.').trim();
 if(/non-fast-forward|fetch first|updates were rejected|rejected .*\[remote rejected\]/i.test(details))
  return 'GitHub rejected this push because the target branch has incompatible or newer commits. Sync/merge the remote branch or choose a fresh branch; the app never force-pushes over remote history.';
 if(/authentication failed|could not read Username|permission to .+ denied|repository not found|HTTP 403|status code 403/i.test(details))
  return 'GitHub denied repository access. Reconnect GitHub and confirm your OAuth authorization allows write access to the selected repository.';
 if(/could not resolve host|failed to connect|connection timed out|network is unreachable|could not resolve proxy/i.test(details))
  return 'Could not reach GitHub while pushing. Check the server network/availability and retry.';
 if(/index\.lock|another git process seems to be running|unable to create .*lock/i.test(details))
  return 'Git is locked by another operation. Wait for the previous push/sync to finish and retry.';
 if(/src refspec .* does not match any|nothing to commit|no commits yet/i.test(details))
  return 'There is no Git commit to push. Check that the project contains at least one non-ignored file.';
 return details.slice(0,1400)||'Push failed. Please retry and check the project status.';
}
async function sanitizeGitRepository(dir,signal) {
 throwIfAborted(signal);
 const gitPath = path.join(dir, '.git');
 let stat;
 try { stat = await fs.lstat(gitPath); } catch { return false; }
 if (!stat.isDirectory()) throw new Error('Unsupported .git layout: linked/worktree repositories are not accepted.');
 await fs.rm(path.join(gitPath, 'config'), { force: true });
 await fs.rm(path.join(gitPath, 'hooks'), { recursive: true, force: true });
 await runGit(dir, ['init'], {}, signal);
 await runGit(dir, ['config', 'core.hooksPath', gitNullDevice], {}, signal);
 await runGit(dir, ['config', 'commit.gpgSign', 'false'], {}, signal);
 await runGit(dir, ['config', 'tag.gpgSign', 'false'], {}, signal);
 return true;
}
async function ensureGit(dir, cloneUrl, signal) {
 throwIfAborted(signal);
 await fs.mkdir(dir, { recursive: true });
 const initialized = !(await sanitizeGitRepository(dir,signal));
 if (initialized) await runGit(dir, ['init'], {}, signal);
 await runGit(dir, ['config', 'core.hooksPath', gitNullDevice], {}, signal);
 await runGit(dir, ['config', 'user.name', APP_NAME], {}, signal);
 await runGit(dir, ['config', 'user.email', 'github-project-pusher@localhost'], {}, signal);
 if (cloneUrl) {
  const hasOrigin = await runGit(dir, ['remote', 'get-url', 'origin'], {}, signal)
   .then(()=>true)
   .catch(error=>{if(signal?.aborted)throw error;return false});
  if(hasOrigin) await runGit(dir, ['remote', 'set-url', 'origin', cloneUrl], {}, signal);
  else await runGit(dir, ['remote', 'add', 'origin', cloneUrl], {}, signal);
 }
 return initialized;
}
function askpassScript() { return path.join(os.tmpdir(), 'gpp-askpass-' + crypto.randomUUID() + '.cjs'); }
async function withGitAuth(token, fn) {
 const file = askpassScript();
 await fs.writeFile(file, "const p=process.argv.slice(2).join(' ');process.stdout.write(/username/i.test(p)?'x-access-token':(process.env.GH_TOKEN||''));\n");
 try { await fs.chmod(file, 0o700); return await fn({ GIT_ASKPASS: file, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }); }
 finally { await fs.rm(file, { force: true }); }
}
async function runGit(cwd, args, env = {}, signal) {
 throwIfAborted(signal);
 const options = {
  cwd,
  env: {
   ...process.env,
   GIT_CONFIG_NOSYSTEM: '1',
   GIT_CONFIG_GLOBAL: gitNullDevice,
   GIT_CONFIG_SYSTEM: gitNullDevice,
   GIT_CONFIG_COUNT: '0',
   GIT_TERMINAL_PROMPT: '0',
   ...env
  },
  maxBuffer: 12 * 1024 * 1024
 };
 if(signal)options.signal=signal;
 try {
  return await execFileAsync('git', args, options);
 } catch(error) {
  if(signal?.aborted) {
   const cancelled=new Error('Push cancelled by user.');
   cancelled.name='AbortError';
   cancelled.cause=error;
   throw cancelled;
  }
  throw error;
 }
}
async function statusPorcelain(dir,signal) { return (await runGit(dir, ['status', '--porcelain'], {}, signal)).stdout.trim(); }
async function rev(dir, name, signal) {
 try { return (await runGit(dir, ['rev-parse', name], {}, signal)).stdout.trim(); }
 catch(error) { if(signal?.aborted)throw error; return null; }
}
`;
server = server.slice(0, helperStart) + helperBlock + server.slice(helperEnd);

const routeStart = server.indexOf("app.post('/api/github/push'");
const routeEnd = server.indexOf('\n\nasync function syncProjectForUser', routeStart);
if (routeStart < 0 || routeEnd < 0) throw new Error('Could not locate the GitHub push route. No files were changed.');
const route = String.raw`app.post('/api/github/push', ensureRequestProtection, async (req, res) => {
 const controller=new AbortController();
 const signal=controller.signal;
 const onResponseClose=()=>{if(!res.writableEnded)controller.abort()};
 res.once('close',onResponseClose);
 let projectId='';
 let userId='';
 try {
  const a=await authUser(req,res);
  if(!a)return;
  userId=String(a.user.id);
  const { projectId: requestedProjectId, repoId, repoName, visibility='private', branch='main' }=req.body||{};
  projectId=String(requestedProjectId||'');
  if(!projectId)return res.status(400).json({error:'Select a project.'});
  const targetBranch=String(branch||'main').trim();
  if(!isValidGitBranch(targetBranch))return res.status(400).json({error:'Enter a valid Git branch name (for example, main or feature/fix).'});
  throwIfAborted(signal);
  const project=await dbGetProject(projectId);
  if(!project||project.userId!==a.user.id)return res.status(404).json({error:'Project not found.'});
  const token=await userToken(a.user);
  if(!token)throw new Error('GitHub authorization is unavailable. Sign out and reconnect GitHub.');
  throwIfAborted(signal);
  await withProjectLock(project.id,async()=>{
   throwIfAborted(signal);
   let repo;
   if(repoId){
    repo=await githubFetch('https://api.github.com/repositories/'+encodeURIComponent(String(repoId)),{headers:githubHeaders(token),signal});
   }else{
    const normalizedRepoName=normalizeName(repoName||project.name);
    if(!normalizedRepoName)throw new Error('Enter a valid name for the new GitHub repository.');
    repo=await githubFetch('https://api.github.com/user/repos',{method:'POST',headers:{...githubHeaders(token),'Content-Type':'application/json'},body:JSON.stringify({name:normalizedRepoName,private:visibility!=='public',auto_init:false}),signal});
   }
   throwIfAborted(signal);
   let updatedProject={...project,repoId:repo.id,repoFullName:repo.full_name,repoUrl:repo.html_url,remoteUrl:repo.clone_url,branch:targetBranch};
   await withWorkspace(project,async dir=>{
    throwIfAborted(signal);
    await snapshotProject(updatedProject,dir,'before-push');
    throwIfAborted(signal);
    await ensureGit(dir,repo.clone_url,signal);
    await withGitAuth(token,async env=>{
     throwIfAborted(signal);
     // Do not hide fetch/auth/network errors; doing so makes later Git failures misleading.
     await runGit(dir,['fetch','origin'],env,signal);
     throwIfAborted(signal);
     const remoteRef=await rev(dir,'origin/'+targetBranch,signal);
     const head=await rev(dir,'HEAD',signal);
     // A fresh local project has untracked files, so history must be checked independently of worktree dirtiness.
     if(remoteRef&&!head)throw new Error('The selected GitHub branch already has commit history, but this project has no shared Git history. Choose an empty repository/branch or merge the remote history first. No remote commits were overwritten.');
     if(remoteRef&&head){
      const commonBase=await runGit(dir,['merge-base','HEAD','origin/'+targetBranch],env,signal)
       .then(result=>result.stdout.trim())
       .catch(error=>{if(signal.aborted)throw error;return ''});
      if(!commonBase)throw new Error('This project and the selected GitHub branch have unrelated histories. Use an empty repository/branch or merge them manually before pushing.');
      const localIsAncestor=await runGit(dir,['merge-base','--is-ancestor','HEAD','origin/'+targetBranch],env,signal)
       .then(()=>true).catch(error=>{if(signal.aborted)throw error;return false});
      const remoteIsAncestor=await runGit(dir,['merge-base','--is-ancestor','origin/'+targetBranch,'HEAD'],env,signal)
       .then(()=>true).catch(error=>{if(signal.aborted)throw error;return false});
      if(localIsAncestor&&!remoteIsAncestor)throw new Error('The GitHub branch has newer commits missing from this project. Pull/sync those changes before pushing again; the app will not overwrite them.');
      if(!localIsAncestor&&!remoteIsAncestor)throw new Error('This project and the GitHub branch have diverged. Merge or sync the remote changes before pushing; the app will not force-push.');
     }
     throwIfAborted(signal);
     await runGit(dir,['add','-A'],env,signal);
     let changes=true;
     try{await runGit(dir,['diff','--cached','--quiet'],env,signal);changes=false}
     catch(error){if(signal.aborted)throw error;changes=true}
     if(changes)await runGit(dir,['commit','-m','Sync from '+APP_NAME+' '+nowIso()],env,signal);
     if(!(await rev(dir,'HEAD',signal)))throw new Error('This project has no Git commit to push. Check that at least one non-ignored file is included.');
     await runGit(dir,['branch','-M',targetBranch],env,signal);
     await runGit(dir,['push','-u','origin',targetBranch],env,signal);
    });
    const commit=await rev(dir,'HEAD');
    await snapshotProject(updatedProject,dir,'after-push');
    const persisted=await persistWorkingTree(updatedProject,dir);
    updatedProject={...updatedProject,storagePath:persisted.storagePath,fileCount:await countFiles(dir),lastPushedAt:nowIso(),lastPushedCommit:commit,syncState:'synced',syncMessage:'Push completed.'};
   });
   await dbUpsertProject(updatedProject);
   Object.assign(project,updatedProject);
  });
  if(signal.aborted||res.destroyed)return;
  broadcast(a.user.id,{type:'project-updated',projectId:project.id,reason:'push'});
  res.json({ok:true,repo:{full_name:project.repoFullName,html_url:project.repoUrl},project:{...project,files:project.fileCount}});
 } catch(error) {
  const cancelled=signal.aborted||error?.name==='AbortError';
  if(!cancelled&&projectId&&userId)await updateProject(projectId,userId,{syncState:'error',syncMessage:formatPushError(error)}).catch(()=>{});
  if(res.destroyed||res.writableEnded)return;
  if(cancelled)return res.status(499).json({error:'Push cancelled.'});
  return res.status(500).json({error:formatPushError(error)});
 } finally {
  res.off('close',onResponseClose);
 }
});`;
server = server.slice(0, routeStart) + route + server.slice(routeEnd);

if (!packageJson.scripts) packageJson.scripts = {};
packageJson.scripts['test:syntax'] = 'node scripts/verify-project.mjs';
const packageContent = JSON.stringify(packageJson, null, 2) + '\n';

const changes = new Map([
  ['server.js', server],
  ['public/app.js', app],
  ['public/index.html', html],
  ['package.json', packageContent]
]);
// Syntax-check the resulting JavaScript before changing any project files.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-fix-check-'));
try {
  for (const file of ['server.js', 'public/app.js']) {
    const tempFile = path.join(tempDir, file.endsWith('.js') && file === 'server.js' ? 'server.mjs' : 'app.js');
    fs.writeFileSync(tempFile, changes.get(file));
    const result = spawnSync(process.execPath, ['--check', tempFile], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Syntax validation failed for ' + file + ':\n' + (result.stderr || result.stdout || 'unknown syntax error'));
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Keep recoverable originals in the OS temporary folder, not inside the Git project.
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-before-fix-'));
for (const file of changes.keys()) {
  const backup = path.join(backupDir, file.replaceAll('/', '__') + '.bak');
  fs.writeFileSync(backup, read(file));
}
for (const [file, content] of changes) fs.writeFileSync(path.join(root, file), content, 'utf8');
console.log('Updated server push cancellation/history checks, dashboard cancel handlers, and the syntax-test command.');
console.log('Backup of original files: ' + backupDir);
console.log('Next run: npm install --no-audit --no-fund && npm run test:syntax');
