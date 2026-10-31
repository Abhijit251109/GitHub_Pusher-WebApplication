import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_EDITOR_BYTES, parseEditorPath, listEditorDirectory, readEditorFile, parseFileEdit, writeEditorFile } from '../lib/project-files.js';
import { parseCommitMessage } from '../lib/security.js';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pusher-editor-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('editor paths reject traversal, git metadata, generated root folders and non-string paths', () => {
  assert.equal(parseEditorPath('src/नमस्ते app.js'), 'src/नमस्ते app.js');
  assert.equal(parseEditorPath(undefined, { directory: true }), '');
  for (const value of ['../outside', '/etc/passwd', 'a/../../b', 'a//b', 'a/./b', 'C:/x', 'a\\b', '.git/config', 'src/.GiT/hooks/x', 'node_modules/a.js', 'a\0b', {}, ['a'], '']) {
    assert.throws(() => parseEditorPath(value), { code: 'INVALID_FILE_PATH' }, String(value));
  }
});

test('explorer lists folders first and hides metadata, excluded folders, links and special files', async t => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'readme.md'), 'hello');
  try {
    await fs.symlink(os.tmpdir(), path.join(root, 'linked'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip('symbolic link creation is not permitted in this environment');
      return;
    }
    throw error;
  }
  const listing = await listEditorDirectory(root, '');
  assert.deepEqual(listing.entries.map(x => [x.name, x.type]), [['src', 'directory'], ['readme.md', 'file']]);
  await assert.rejects(listEditorDirectory(root, 'linked'), { code: 'INVALID_FILE_PATH' });
  await assert.rejects(readEditorFile(root, 'linked/nope'), { code: 'INVALID_FILE_PATH' });
  await assert.rejects(readEditorFile(root, 'missing.txt'), { code: 'FILE_NOT_FOUND' });
});

test('UTF-8, BOM, CRLF and empty files round trip; stale versions cannot overwrite newer edits', async t => {
  const root = await workspace(t);
  const initial = '\ufeffhello\r\nनमस्ते\r\n';
  await fs.writeFile(path.join(root, 'file.txt'), initial);
  const opened = await readEditorFile(root, 'file.txt');
  assert.equal(opened.content, initial);
  const noChange = await writeEditorFile(root, parseFileEdit(opened));
  assert.equal(noChange.changed, false);
  const saved = await writeEditorFile(root, parseFileEdit({ ...opened, content: '\ufeffupdated\r\n' }));
  assert.equal(saved.changed, true);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), '\ufeffupdated\r\n');
  await assert.rejects(writeEditorFile(root, parseFileEdit({ ...opened, content: 'stale tab' })), { code: 'FILE_CHANGED' });
  assert.equal((await readEditorFile(root, 'file.txt')).sha, saved.sha);
  await writeEditorFile(root, parseFileEdit({ ...saved, content: '' }));
  assert.equal((await readEditorFile(root, 'file.txt')).size, 0);
});

test('binary, invalid UTF-8, large files and invalid save versions are refused', async t => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 65, 66]));
  await fs.writeFile(path.join(root, 'bad-utf8'), Buffer.from([0xff, 0xfe]));
  await fs.writeFile(path.join(root, 'large'), Buffer.alloc(MAX_EDITOR_BYTES + 1, 65));
  for (const name of ['binary', 'bad-utf8']) await assert.rejects(readEditorFile(root, name), { code: 'BINARY_FILE' });
  await assert.rejects(readEditorFile(root, 'large'), { code: 'FILE_TOO_LARGE' });
  assert.throws(() => parseFileEdit({ path: 'x', content: 'hello', sha: 'bad' }), { code: 'INVALID_FILE_VERSION' });
  assert.throws(() => parseFileEdit({ path: 'x', content: 'a\0b', sha: 'a'.repeat(64) }), { code: 'INVALID_FILE_CONTENT' });
  assert.throws(() => parseFileEdit({ path: 'x', content: 'é'.repeat(MAX_EDITOR_BYTES), sha: 'a'.repeat(64) }), { code: 'FILE_TOO_LARGE' });
});

test('custom messages preserve user text; blank uses the default and invalid input is rejected', () => {
  const message = 'Fix folder import\n\nKeep nested files. नमस्ते';
  assert.equal(parseCommitMessage(message), message);
  assert.equal(parseCommitMessage('  exact spacing  '), '  exact spacing  ');
  for (const value of [undefined, null, '', ' \t\r\n']) assert.equal(parseCommitMessage(value), null);
  for (const value of [42, {}, ['x'], 'x\0y', 'x'.repeat(5001)]) assert.throws(() => parseCommitMessage(value), { code: 'INVALID_COMMIT_MESSAGE' });
});
