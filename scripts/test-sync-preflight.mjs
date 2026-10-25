import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteRefUrl, remoteMatchesKnownCommit } from '../lib/sync-preflight.js';

const sha = 'a'.repeat(40);
test('background preflight recognizes only an exact commit SHA, never tags or empty results', () => {
  assert.equal(remoteMatchesKnownCommit({ object: { type: 'commit', sha } }, sha), true);
  for (const input of [{}, null, { object: { type: 'tag', sha } }, { object: { type: 'commit', sha: 'b'.repeat(40) } }]) {
    assert.equal(remoteMatchesKnownCommit(input, sha), false);
  }
  assert.equal(remoteMatchesKnownCommit({ object: { type: 'commit', sha: 'oops' } }, 'oops'), false);
});
test('ref URL safely handles nested branch names and rejects incomplete repository names', () => {
  assert.equal(remoteRefUrl('owner/repo', 'feature/bugfix'), 'https://api.github.com/repos/owner/repo/git/ref/heads/feature/bugfix');
  assert.equal(remoteRefUrl('own er/repo', 'branch'), 'https://api.github.com/repos/own%20er/repo/git/ref/heads/branch');
  assert.throws(() => remoteRefUrl('owneronly', 'main'));
  assert.throws(() => remoteRefUrl('owner/repo', ''));
});
