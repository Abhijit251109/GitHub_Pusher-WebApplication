import { AppError, parseBranch } from './security.js';

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_TASK_LENGTH = 4000;

export function parseAgentTask(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TASK_LENGTH || /\0/.test(value)) {
    throw new AppError('INVALID_AGENT_TASK', `Describe the task in at most ${MAX_TASK_LENGTH} characters.`);
  }
  return value.trim();
}

export function buildGitHubPusherSession({ model, credentialId, environmentId, repoFullName, branch, task }) {
  const [owner, repository, ...extra] = String(repoFullName || '').split('/');
  if (!owner || !repository || extra.length || owner === '.' || owner === '..' || repository === '.' || repository === '..' ||
      !REPOSITORY_NAME.test(owner) || !REPOSITORY_NAME.test(repository)) {
    throw new AppError('INVALID_AGENT_REPOSITORY', 'The selected project is not linked to a valid GitHub repository.');
  }
  if (typeof credentialId !== 'string' || !credentialId.trim()) {
    throw new AppError('GITHUB_AGENT_NOT_CONFIGURED', 'The GitHub agent is not configured on the server.', { status: 503 });
  }

  const targetBranch = parseBranch(branch);
  const taskText = parseAgentTask(task);
  const target = `${owner}/${repository}`;

  return {
    agent: {
      model,
      instructions: [
        'You are GitHub Pusher Agent, a coding assistant using the provided execution environment and connected GitHub MCP tools.',
        `The only authorized repository is ${target}; the only authorized branch is ${targetBranch}.`,
        'Inspect the repository and current branch before making changes. Make only changes needed for the user task.',
        'Never access another repository, print or expose credentials, commit secrets, force-push, or rewrite remote history.',
        'Run the repository checks when the connected tools make that possible. Report checks you could not run honestly.',
        'The user explicitly confirmed this run may commit and push changes to the selected repository and branch. Push only the requested, tested changes; if checks fail, the branch differs, or a conflict requires rewriting history, stop and report instead.',
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
          credential_id: credentialId,
          allowed_tools: null
        }
      ],
      multi_agent: {
        enabled: true,
        max_concurrent_subagents: 10
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
    stream: true
  };
}
