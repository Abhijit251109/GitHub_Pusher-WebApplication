// Runs git with an isolated config, hard time limits and GitHub credentials (tested in scripts/test-push-safety.mjs).
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GIT_TIMEOUT, PushError, authSetupError } from './push-core.js';

const execFileAsync = promisify(execFile);

// Each call is killed after `timeoutMs`, or at once when `signal` (a job deadline) fires.
// A killed call becomes PushError(GIT_TIMEOUT) so callers never mistake it for a normal git failure.
export function createGitRunner({ timeoutMs, jobTimeoutMs }) {
  return async function runGit(cwd, args, env = {}, { input, signal } = {}) {
    const run = execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      signal,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_TERMINAL_PROMPT: '0',
        ...env
      },
      maxBuffer: 50 * 1024 * 1024 // Increased from 12MB to 50MB for large repos
    });
    if (input != null) run.child.stdin.end(input);
    try {
      return await run;
    } catch (e) {
      if (e.killed || e.name === 'AbortError') {
        const why = signal?.aborted ? `job exceeded JOB_TIMEOUT_MS (${jobTimeoutMs} ms)` : `call exceeded GIT_TIMEOUT_MS (${timeoutMs} ms)`;
        throw new PushError(GIT_TIMEOUT, 'A git operation took too long and was stopped. Nothing on GitHub was overwritten. Try again; a very large project may need longer timeouts.', { status: 504, internal: `git ${args[0]} in ${cwd}: ${why}` });
      }
      throw e;
    }
  };
}

// Environment that makes git answer GitHub's credential prompt with `token`. The helper is an
// inline shell function passed as git config, so nothing has to be written to disk or be
// executable, and the token stays in the environment (never in argv). The first, empty
// credential.helper entry drops any helpers configured elsewhere.
// Replaces a GIT_ASKPASS .cjs file that had no shebang: git ran it with /bin/sh, which failed
// with a syntax error, so every fetch/push ended in "could not read Username".
export function gitAuthEnv(token) {
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
    GH_TOKEN: String(token || ''),
    GIT_TERMINAL_PROMPT: '0'
  };
}
export async function withGitAuth(token, fn) {
  return fn(gitAuthEnv(token));
}

// No-network proof that git receives the token from gitAuthEnv: asks git for the credentials it
// would send to github.com and compares the password with the token.
export async function checkGitCredentials(runGit, cwd, env, token) {
  let stdout = '';
  try {
    ({ stdout } = await runGit(cwd, ['credential', 'fill'], env, { input: 'protocol=https\nhost=github.com\n\n' }));
  } catch (e) {
    if (e?.code === GIT_TIMEOUT) throw e;
    throw authSetupError(String(e?.stderr || e?.message || e).trim());
  }
  if (!stdout.split('\n').includes(`password=${token}`)) throw authSetupError('git credential fill did not return the expected token');
}
