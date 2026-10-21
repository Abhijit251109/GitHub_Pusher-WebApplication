// Runs git with an isolated config and hard time limits (tested in scripts/test-push-safety.mjs).
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GIT_TIMEOUT, PushError } from './push-core.js';

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
