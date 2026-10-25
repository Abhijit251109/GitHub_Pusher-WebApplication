// Background-only optimization: never interpret a missing or unexpected GitHub response
// as proof that the local workspace is up to date.
export function remoteRefUrl(repoFullName, branch) {
  const repoParts = String(repoFullName || '').split('/');
  if (repoParts.length !== 2 || repoParts.some(part => !part)) throw new TypeError('Invalid repository name');
  if (!branch || typeof branch !== 'string') throw new TypeError('Invalid branch name');
  return `https://api.github.com/repos/${repoParts.map(encodeURIComponent).join('/')}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

export function remoteMatchesKnownCommit(ref, known) {
  return typeof known === 'string' && /^[0-9a-f]{40,64}$/.test(known) &&
    ref?.object?.type === 'commit' && ref.object.sha === known;
}
