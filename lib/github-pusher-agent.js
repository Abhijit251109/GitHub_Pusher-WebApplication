import { AppError, parseBranch } from './security.js';

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_TASK_LENGTH = 4000;

export function parseAgentTask(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TASK_LENGTH || /\0/.test(value)) {
    throw new AppError('INVALID_AGENT_TASK', `Describe the task in at most ${MAX_TASK_LENGTH} characters.`);
  }
  return value.trim();
}

export function buildGitHubPusherSession({ model, vaultId, credentialId, environmentId, repoFullName, branch, task }) {
  const [owner, repository, ...extra] = String(repoFullName || '').split('/');
  if (!owner || !repository || extra.length || owner === '.' || owner === '..' || repository === '.' || repository === '..' ||
      !REPOSITORY_NAME.test(owner) || !REPOSITORY_NAME.test(repository)) {
    throw new AppError('INVALID_AGENT_REPOSITORY', 'The selected project is not linked to a valid GitHub repository.');
  }
  if (typeof vaultId !== 'string' || !vaultId.trim()) {
    throw new AppError('GITHUB_AGENT_NOT_CONFIGURED', 'The GitHub agent vault is not configured on the server.', { status: 503 });
  }

  const targetBranch = parseBranch(branch);
  const taskText = parseAgentTask(task);
  const target = `${owner}/${repository}`;
  const writeAuthorized = /\b(?:you may|please|go ahead and|I authorize you to)\s+(?:make changes?\s+and\s+)?(?:commit\s+and\s+push|push)\b|\bcommit\s+and\s+push\s+(?:the\s+)?(?:changes|fixes|work)\b/i.test(taskText)
    && !/\b(?:do not|don't|never|without)\s+(?:modify|change|commit|push)\b/i.test(taskText);

  return {
    agent: {
      model,
      instructions: [
        'You are GitHub Pusher Agent, a coding assistant using the provided execution environment and connected GitHub MCP tools.',
        'You are the main coordinator and are responsible for the complete task, all delegated work, every remote operation, and the final report.',
        `The only authorized repository is ${target}; the only authorized branch is ${targetBranch}.`,
        'Inspect the repository and current branch before making changes. Make only changes needed for the user task.',
        'Use no more than four subagents, and delegate only when useful: subagent 1 handles GitHub fetch, pull, and push operations; subagent 2 implements code changes; subagent 3 investigates bugs and runs debugging checks; subagent 4 independently analyzes the full change and checks for mistakes.',
        'Supervise all subagents: give each a bounded task, inspect its results, resolve disagreements, and integrate only work that you have reviewed. Subagent 1 may perform a fetch, pull, or push only after you have reviewed and explicitly approved that exact operation.',
        'Before every fetch, pull, or push, recheck the selected repository and branch, current remote/local state, intended changes, and relevant safety risks. Before any push, inspect the complete diff and run relevant checks; do not push if the review or checks find an unresolved problem.',
        'After each remote operation, verify its outcome against the intended repository, branch, and changes. Before the final response, independently review the complete result, delegated work, remote-operation outcomes, and checks; clearly report any issue that remains.',
        'Never access another repository, print or expose credentials, commit secrets, force-push, or rewrite remote history.',
        'Run the repository checks when the connected tools make that possible. Report checks you could not run honestly.',
        'Treat every task as read-only unless the task itself explicitly and unambiguously authorizes making changes AND committing and pushing them. A button click or general app capability is not authorization. If the task says not to modify, commit, or push, do not do so. When write authorization is absent or ambiguous, inspect and report only; do not create commits or push. Even with explicit authorization, push only the requested, tested changes; inspect the complete diff and run relevant checks first. If checks fail, the branch differs, or a conflict requires rewriting history, stop and report instead.',
        `Write authorization for this run: ${writeAuthorized ? 'EXPLICITLY AUTHORIZED by the task' : 'NOT AUTHORIZED — READ-ONLY; do not edit, commit, or push'}.`,
        'Report the files changed, checks performed, and resulting commit or why no push occurred.'
      ].join(' '),
      tools: [
        {
          type: 'web_search',
          mode: 'live',
          context_size: 'medium',
          allowed_domains: null,
          location: null
        },
        {
          type: 'mcp',
          server_label: 'github',
          required: true,
          transport: {
            type: 'http',
            server_url: 'https://api.githubcopilot.com/mcp/'
          },
          connection_origin: 'service',
          ...(typeof credentialId === 'string' && credentialId.trim() ? { credential_id: credentialId.trim() } : {}),
          allowed_tools: null
        }
      ],
      multi_agent: {
        enabled: true,
        max_concurrent_subagents: 4
      },
      reasoning: {
        effort: 'high',
        summary: 'concise'
      },
      text: {
        format: {
          type: 'text'
        },
        verbosity: 'medium'
      }
    },
    environment: environmentId
      ? { type: 'openai_hosted', environment_id: environmentId }
      : { type: 'none' },
    input: `Target repository: ${target}\nTarget branch: ${targetBranch}\n\nUser task:\n${taskText}`,
    vault_ids: [vaultId.trim()],
    stream: true
  };
}
