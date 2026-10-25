import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { loadAIConfig, safeAIPath, parseAIRequest, proposeEdits } from '../lib/ai-agent.js';

const file = (path = 'src/app.js', content = 'export const count = 1;\n') => ({ path, content, sha: crypto.createHash('sha256').update(content).digest('hex') });
const config = loadAIConfig({ AI_ENABLED: 'true', AI_MODEL: 'local-coder' });
const request = () => ({ instruction: 'Set count to two.', files: [file()] });
const proposal = (content = 'export const count = 2;\n') => ({ summary: 'Update count.', changes: [{ path: 'src/app.js', content, explanation: 'Set the requested value.' }] });
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
const respond = value => async () => Response.json(completion(value));

test('AI stays disabled without an explicit true flag', async () => {
  for (const env of [{}, { AI_ENABLED: 'false' }, { AI_ENABLED: '1' }]) assert.equal(loadAIConfig(env), null);
  await assert.rejects(proposeEdits(null, request()), { code: 'AI_DISABLED', status: 503 });
});

test('AI config permits local inference and requires authenticated HTTPS remotely', () => {
  assert.equal(config.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(config.timeoutMs, 60000);
  const remote = loadAIConfig({ AI_ENABLED: 'true', AI_MODEL: 'coder', AI_BASE_URL: 'https://models.example/v1/', AI_API_KEY: 'test-key' });
  assert.equal(remote.baseURL, 'https://models.example/v1');
  for (const extra of [
    { AI_MODEL: '' }, { AI_BASE_URL: 'http://models.example/v1', AI_API_KEY: 'key' },
    { AI_BASE_URL: 'https://models.example/v1' }, { AI_BASE_URL: 'ftp://localhost/v1' },
    { AI_BASE_URL: 'http://user:password@localhost/v1' }, { AI_BASE_URL: 'http://localhost/v1?key=x' },
    { AI_BASE_URL: 'http://localhost/v1#x' }, { AI_TIMEOUT_MS: '60001' }, { AI_TIMEOUT_MS: 'NaN' },
    { AI_API_KEY: 'key\nheader' }
  ]) assert.throws(() => loadAIConfig({ AI_ENABLED: 'true', AI_MODEL: 'coder', ...extra }), { code: 'AI_CONFIG_INVALID' });
});

test('AI context paths reject traversal, generated files, secrets and credentials', () => {
  assert.equal(safeAIPath('src/नमस्ते.js'), 'src/नमस्ते.js');
  for (const path of ['../x', '/x', '.git/config', 'node_modules/a', '.env', '.env.example', 'config/.env.local', '.ssh/id_rsa', '.aws/credentials', 'credentials.json', 'cert.pem', 'private.key', 'project.env', '.npmrc', 'secrets.yaml', '.config/token']) {
    assert.throws(() => safeAIPath(path), undefined, path);
  }
});

test('AI request validation rejects arbitrary provider options and invalid selections', () => {
  assert.deepEqual(parseAIRequest({ instruction: ' Fix count ', paths: ['src/app.js'] }), { instruction: 'Fix count', paths: ['src/app.js'] });
  for (const value of [null, {}, { instruction: ' ', paths: ['a.js'] }, { instruction: 'x', paths: [] },
    { instruction: 'x', paths: Array.from({ length: 7 }, (_, i) => `${i}.js`) },
    { instruction: 'x', paths: ['a.js', 'a.js'] }, { instruction: 'x'.repeat(4001), paths: ['a.js'] },
    { instruction: 'x', paths: ['a.js'], model: 'attacker-model' }, { instruction: 'x', paths: ['a.js'], baseURL: 'https://attacker.example' }
  ]) assert.throws(() => parseAIRequest(value), { code: 'AI_INVALID_REQUEST' });
});

test('real local provider receives only selected context and returns a review proposal', async t => {
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion(proposal())));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const localConfig = loadAIConfig({ AI_ENABLED: 'true', AI_MODEL: 'local-coder', AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_API_KEY: 'server-test-key' });
  const original = file();
  const result = await proposeEdits(localConfig, { instruction: 'Set count to two.', files: [{ ...original, sessionToken: 'never-send-session', githubToken: 'never-send-github' }] });
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.headers.authorization, 'Bearer server-test-key');
  assert.equal(received.body.model, 'local-coder');
  assert.deepEqual(received.body.messages.map(x => x.role), ['system', 'user']);
  assert.match(received.body.messages[0].content, /untrusted data/);
  assert.deepEqual(JSON.parse(received.body.messages[1].content), { instruction: 'Set count to two.', files: [{ path: original.path, content: original.content }] });
  assert.doesNotMatch(JSON.stringify(received.body), /never-send|server-test-key/);
  assert.equal(result.changes[0].sha, original.sha);
  assert.equal(result.changes[0].originalContent, original.content);
  assert.equal(result.changes[0].content, 'export const count = 2;\n');
  assert.equal(result.model, 'local-coder');
  assert.equal(original.content, 'export const count = 1;\n');
});

test('context hashes and size are checked before any network call', async () => {
  let calls = 0;
  const options = { fetch: async () => { calls++; return Response.json(completion(proposal())); } };
  await assert.rejects(proposeEdits(config, { ...request(), files: [{ ...file(), sha: '0'.repeat(64) }] }, options), { code: 'AI_STALE_CONTEXT', status: 409 });
  await assert.rejects(proposeEdits(config, { ...request(), files: [file('big.js', 'é'.repeat(25000))] }, options), { code: 'AI_CONTEXT_TOO_LARGE', status: 413 });
  await assert.rejects(proposeEdits(config, { ...request(), files: [file('.env', 'TOKEN=private')] }, options), { code: 'AI_SENSITIVE_FILE' });
  assert.equal(calls, 0);
});

test('unchanged files are omitted and a complete empty replacement is retained', async () => {
  const same = await proposeEdits(config, request(), { fetch: respond(proposal(file().content)) });
  assert.deepEqual(same.changes, []);
  const empty = await proposeEdits(config, request(), { fetch: respond(proposal('')) });
  assert.equal(empty.changes[0].content, '');
  const none = await proposeEdits(config, request(), { fetch: respond({ summary: 'More context is needed.', changes: [] }) });
  assert.deepEqual(none.changes, []);
});

test('unselected files, duplicates, binary contents and model commands are refused', async () => {
  const base = proposal();
  for (const value of [
    { ...base, changes: [{ ...base.changes[0], path: 'other.js' }] },
    { ...base, changes: [base.changes[0], base.changes[0]] },
    { ...base, changes: [{ ...base.changes[0], content: 'bad\0content' }] },
    { ...base, changes: [{ ...base.changes[0], command: 'rm -rf /' }] },
    { ...base, command: 'git push' }, { summary: 'x', changes: null },
    { summary: '', changes: [] }, { summary: 'x', changes: [{ path: 'src/app.js', content: 'x' }] },
    { ...base, changes: [{ ...base.changes[0], content: 'x'.repeat(96 * 1024 + 1) }] }
  ]) await assert.rejects(proposeEdits(config, request(), { fetch: respond(value) }), { code: 'AI_INVALID_RESPONSE' });
});

test('tool calls and truncated completions never become applicable proposals', async () => {
  for (const override of [{ finish_reason: 'length' }, { message: { content: JSON.stringify(proposal()), tool_calls: [{ function: { name: 'shell' } }] } }]) {
    const value = completion(proposal());
    Object.assign(value.choices[0], override);
    await assert.rejects(proposeEdits(config, request(), { fetch: async () => Response.json(value) }), { code: 'AI_INVALID_RESPONSE' });
  }
});

test('single JSON code fences from local models are accepted', async () => {
  const value = completion(proposal());
  value.choices[0].message.content = '```json\n' + JSON.stringify(proposal()) + '\n```';
  assert.equal((await proposeEdits(config, request(), { fetch: async () => Response.json(value) })).changes.length, 1);
});

test('upstream failures are sanitized and redirects are disabled', async () => {
  let fetchOptions;
  const fetch = async (_url, options) => { fetchOptions = options; return new Response('private API key and source', { status: 401 }); };
  await assert.rejects(proposeEdits(config, request(), { fetch }), error => error.code === 'AI_PROVIDER_ERROR' && !/private API key/.test(error.message) && !error.internal);
  assert.equal(fetchOptions.redirect, 'error');
  await assert.rejects(proposeEdits(config, request(), { fetch: async () => { throw new Error('network private secret'); } }), error => error.code === 'AI_PROVIDER_ERROR' && !/private secret/.test(error.message));
  await assert.rejects(proposeEdits(config, request(), { fetch: async () => new Response('quota details', { status: 429 }) }), { code: 'AI_PROVIDER_ERROR', status: 503 });
});

test('provider responses are capped by declared and streamed bytes', async () => {
  await assert.rejects(proposeEdits(config, request(), { fetch: async () => new Response('{}', { headers: { 'Content-Length': String(193 * 1024) } }) }), { code: 'AI_INVALID_RESPONSE' });
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(proposeEdits(config, request(), { fetch: async () => new Response(stream) }), { code: 'AI_INVALID_RESPONSE' });
  assert.equal(cancelled, true);
});

test('malformed provider envelopes and JSON return safe errors', async () => {
  for (const text of ['not JSON', '{}', '{"choices":[]}', JSON.stringify(completion({ invalid: true }))]) {
    await assert.rejects(proposeEdits(config, request(), { fetch: async () => new Response(text) }), error => /^AI_(INVALID_RESPONSE|PROVIDER_ERROR)$/.test(error.code) && error.status === 502);
  }
});

test('caller cancellation is propagated without exposing exception details', async () => {
  const controller = new AbortController();
  controller.abort(new Error('secret cancellation reason'));
  await assert.rejects(proposeEdits(config, request(), { signal: controller.signal, fetch: async (_url, { signal }) => { signal.throwIfAborted(); } }), { code: 'AI_CANCELLED', status: 499 });
});

test('inference timeout aborts the operation with a safe timeout result', async () => {
  const timed = { ...config, timeoutMs: 1000 };
  // Keep an active handle: AbortSignal.timeout is deliberately unrefed by Node.
  const keepAlive = setInterval(() => {}, 2000);
  try {
    await assert.rejects(proposeEdits(timed, request(), { fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) }), { code: 'AI_TIMEOUT', status: 504 });
  } finally { clearInterval(keepAlive); }
});
