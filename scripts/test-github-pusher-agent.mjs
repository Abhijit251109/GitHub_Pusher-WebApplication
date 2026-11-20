import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGitHubPusherSession, parseAgentTask } from '../lib/github-pusher-agent.js';

test('GitHub Pusher session is scoped to the selected repository and branch', () => {
  const session = buildGitHubPusherSession({
    model: 'gpt-6-sol',
    vaultId: 'vault-server-side',
    credentialId: 'credential-server-side',
    environmentId: 'ccarenv_b64_example',
    repoFullName: 'owner/repo',
    branch: 'feature/fix-push',
    task: 'Fix the authentication regression and run the tests.'
  });

  assert.equal(session.agent.model, 'gpt-6-sol');
  assert.equal(Object.hasOwn(session.agent, 'name'), false);
  const mcpTool = session.agent.tools.find(tool => tool.type === 'mcp');
  assert.equal(mcpTool.credential_id, 'credential-server-side');
  assert.equal(mcpTool.connection_origin, 'service');
  assert.deepEqual(session.vault_ids, ['vault-server-side']);
  assert.deepEqual(session.environment, { type: 'openai_hosted', environment_id: 'ccarenv_b64_example' });
  assert.equal(session.stream, true);
  assert.equal(session.agent.multi_agent.enabled, true);
  assert.equal(session.agent.multi_agent.max_concurrent_subagents, 4);
  assert.match(session.agent.instructions, /only authorized repository is owner\/repo/i);
  assert.match(session.agent.instructions, /only authorized branch is feature\/fix-push/i);
  assert.match(session.agent.instructions, /main coordinator/i);
  assert.match(session.agent.instructions, /subagent 1 handles GitHub fetch, pull, and push/i);
  assert.match(session.agent.instructions, /subagent 2 implements code changes/i);
  assert.match(session.agent.instructions, /subagent 3 investigates bugs/i);
  assert.match(session.agent.instructions, /subagent 4 independently analyzes the full change/i);
  assert.match(session.agent.instructions, /Before every fetch, pull, or push, recheck/i);
  assert.match(session.agent.instructions, /Before the final response, independently review the complete result/i);
  assert.match(session.agent.instructions, /Never access another repository.*force-push/is);
  assert.match(session.input, /Target repository: owner\/repo/);
  assert.match(session.input, /Target branch: feature\/fix-push/);
  assert.match(session.agent.instructions, /NOT AUTHORIZED — READ-ONLY/);
  assert.match(session.agent.instructions, /do not edit, commit, or push/i);
});

test('GitHub Pusher session rejects invalid repository, task, and credentials', () => {
  const valid = {
    model: 'gpt-6-sol',
    vaultId: 'vault-server-side',
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
  assert.throws(() => buildGitHubPusherSession({ ...valid, vaultId: '' }), { code: 'GITHUB_AGENT_NOT_CONFIGURED' });
  const withoutCredentialId = buildGitHubPusherSession({ ...valid, credentialId: '' });
  assert.equal(Object.hasOwn(withoutCredentialId.agent.tools.find(tool => tool.type === 'mcp'), 'credential_id'), false);
  for (const task of ['', '  ', 'x'.repeat(4001), 'read\0secrets']) {
    assert.throws(() => parseAgentTask(task), { code: 'INVALID_AGENT_TASK' });
  }
});

test('GitHub Pusher write operations require explicit task-level authorization', () => {
  const base = {
    model: 'gpt-6-sol', vaultId: 'vault-server-side', credentialId: '',
    environmentId: '', repoFullName: 'owner/repo', branch: 'main'
  };
  const readOnly = buildGitHubPusherSession({
    ...base,
    task: 'Inspect this repository and report its current branch and project structure. Do not modify or push anything.'
  });
  assert.match(readOnly.agent.instructions, /NOT AUTHORIZED — READ-ONLY/);

  const authorized = buildGitHubPusherSession({
    ...base,
    task: 'Please make the requested fix, run tests, and commit and push the changes.'
  });
  assert.match(authorized.agent.instructions, /EXPLICITLY AUTHORIZED by the task/);
});
