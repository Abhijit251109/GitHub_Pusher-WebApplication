import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGitHubPusherSession, parseAgentTask } from '../lib/github-pusher-agent.js';

test('GitHub Pusher session is scoped to the selected repository and branch', () => {
  const session = buildGitHubPusherSession({
    model: 'gpt-6-sol',
    credentialId: 'credential-server-side',
    environmentId: 'ccarenv_b64_example',
    repoFullName: 'owner/repo',
    branch: 'feature/fix-push',
    task: 'Fix the authentication regression and run the tests.'
  });

  assert.equal(session.agent.model, 'gpt-6-sol');
  assert.equal(Object.hasOwn(session.agent, 'name'), false);
  assert.equal(session.agent.tools.find(tool => tool.type === 'mcp').credential_id, 'credential-server-side');
  assert.deepEqual(session.environment, { type: 'openai_hosted', environment_id: 'ccarenv_b64_example' });
  assert.equal(session.stream, true);
  assert.match(session.agent.instructions, /only authorized repository is owner\/repo/i);
  assert.match(session.agent.instructions, /only authorized branch is feature\/fix-push/i);
  assert.match(session.agent.instructions, /Never access another repository.*force-push/is);
  assert.match(session.input, /Target repository: owner\/repo/);
  assert.match(session.input, /Target branch: feature\/fix-push/);
});

test('GitHub Pusher session rejects invalid repository, task, and credentials', () => {
  const valid = {
    model: 'gpt-6-sol',
    credentialId: 'credential-server-side',
    environmentId: '',
    repoFullName: 'owner/repo',
    branch: 'main',
    task: 'Run project tests.'
  };
  for (const repoFullName of ['owner', 'owner/repo/extra', '../repo', 'owner/repo?x=1']) {
    assert.throws(() => buildGitHubPusherSession({ ...valid, repoFullName }), { code: 'INVALID_AGENT_REPOSITORY' });
  }
  assert.throws(() => buildGitHubPusherSession({ ...valid, branch: '-main' }), { code: 'INVALID_BRANCH' });
  assert.throws(() => buildGitHubPusherSession({ ...valid, credentialId: '' }), { code: 'GITHUB_AGENT_NOT_CONFIGURED' });
  for (const task of ['', '  ', 'x'.repeat(4001), 'read\0secrets']) {
    assert.throws(() => parseAgentTask(task), { code: 'INVALID_AGENT_TASK' });
  }
});
