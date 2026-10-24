// The editor only reads and changes existing regular UTF-8 files in a restored workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from './security.js';
import { isArchiveExcluded } from './push-core.js';

export const MAX_EDITOR_BYTES = 2 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const binaryControls = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

export function parseEditorPath(value, { directory = false } = {}) {
  if (directory && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError('INVALID_FILE_PATH', 'Choose a valid project file or folder.');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /^\.git[. ]*$/i.test(part)) || isArchiveExcluded(value)) {
    throw new AppError('INVALID_FILE_PATH', 'This path is outside the editable project files.');
  }
  return value;
}

async function existingPath(root, relative, directory) {
  let absolute = root;
  const parts = relative ? relative.split('/') : [];
  for (let i = 0; i < parts.length; i++) {
    absolute = path.join(absolute, parts[i]);
    let stat;
    try { stat = await fs.lstat(absolute); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new AppError('FILE_NOT_FOUND', 'This file or folder no longer exists. Refresh the explorer.', { status: 404 });
      throw e;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
      throw new AppError('INVALID_FILE_PATH', 'Links and special files cannot be opened in the editor.');
    }
    if (i === parts.length - 1 && !(directory ? stat.isDirectory() : stat.isFile())) {
      throw new AppError('INVALID_FILE_PATH', directory ? 'Choose a folder.' : 'Choose a regular file.');
    }
  }
  return absolute;
}

export async function listEditorDirectory(root, value) {
  const relative = parseEditorPath(value, { directory: true });
  const absolute = await existingPath(root, relative, true);
  const entries = [];
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    try { parseEditorPath(rel); } catch { continue; }
    if (entry.isDirectory()) entries.push({ name: entry.name, path: rel, type: 'directory' });
    else if (entry.isFile()) entries.push({ name: entry.name, path: rel, type: 'file', size: (await fs.stat(path.join(absolute, entry.name))).size });
  }
  entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  return { path: relative, entries, maxEditorBytes: MAX_EDITOR_BYTES };
}

export async function readEditorFile(root, value) {
  const relative = parseEditorPath(value);
  const absolute = await existingPath(root, relative, false);
  if ((await fs.stat(absolute)).size > MAX_EDITOR_BYTES) throw new AppError('FILE_TOO_LARGE', 'The editor supports text files up to 2 MiB.', { status: 413 });
  const bytes = await fs.readFile(absolute);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    throw new AppError('BINARY_FILE', 'This file is binary or uses an unsupported text encoding. It is kept unchanged.', { status: 415 });
  }
  if (binaryControls.test(content)) throw new AppError('BINARY_FILE', 'Binary files cannot be edited. This file is kept unchanged.', { status: 415 });
  return { path: relative, content, sha: hash(bytes), size: bytes.length };
}

export function parseFileEdit(body = {}) {
  const relative = parseEditorPath(body.path);
  if (typeof body.content !== 'string' || binaryControls.test(body.content)) throw new AppError('INVALID_FILE_CONTENT', 'File contents must be UTF-8 text.');
  if (Buffer.byteLength(body.content, 'utf8') > MAX_EDITOR_BYTES) throw new AppError('FILE_TOO_LARGE', 'The editor supports text files up to 2 MiB.', { status: 413 });
  if (typeof body.sha !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha)) throw new AppError('INVALID_FILE_VERSION', 'Reopen this file before saving.');
  return { path: relative, content: body.content, sha: body.sha };
}

export async function writeEditorFile(root, edit) {
  const current = await readEditorFile(root, edit.path);
  if (current.sha !== edit.sha) throw new AppError('FILE_CHANGED', 'This file changed since you opened it. Copy your draft, then reopen the file to review the latest version.', { status: 409 });
  const bytes = Buffer.from(edit.content, 'utf8');
  const sha = hash(bytes);
  if (sha === current.sha) return { ...current, changed: false };
  await fs.writeFile(await existingPath(root, edit.path, false), bytes);
  return { path: edit.path, content: edit.content, sha, size: bytes.length, changed: true };
}
