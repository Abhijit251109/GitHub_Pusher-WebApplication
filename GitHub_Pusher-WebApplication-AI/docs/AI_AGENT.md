# Pusher AI agent

Pusher AI turns a change request and selected saved files into reviewable replacements. It is integrated into the existing authenticated project editor. You can use a local Ollama coding model or a hosted OpenAI-compatible Chat Completions endpoint.

This package contains the application source, an application-specific prompt, and an optional Ollama model definition. It does not include model weights, training data, a fine-tuned model, or credentials. The optional `pusher-coder` model customizes an existing model's instructions and parameters; it does not train new weights.

## Start the application

1. Install Node 22.22.0 (see `.nvmrc`) and Git, then run `npm ci` from the repository root.
2. Configure the application's GitHub OAuth and Supabase database/private storage using `docs/DEPLOYMENT.md`. These are required for signing in and accessing saved projects. Preserve your existing settings.
3. Add the AI settings below to your private `.env` or backend deployment environment.
4. Run `npm start`. AI configuration is read at startup; restart after changing it.

The static GitHub Pages frontend requires the Node backend for AI requests. Never put provider keys in `public/config.js` or any frontend file. No database migration is required for AI.

## Option A: local Ollama

Install Ollama from its official site on the same machine as the Node backend. Start its service (`ollama serve` if it is not already running), then run:

```sh
ollama pull qwen2.5-coder:7b
ollama create pusher-coder -f ai/Modelfile
```

Add to the backend environment:

```dotenv
AI_ENABLED=true
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=pusher-coder
AI_TIMEOUT_MS=60000
RATE_LIMIT_AI_PER_15_MIN=10
```

Leave `AI_API_KEY` unset for local Ollama. The model download is several GB. RAM/VRAM needs increase with context size; start with small files and an accelerated machine if possible. A smaller compatible model can be used by changing the Modelfile's `FROM` line and recreating the model. Larger requests may exceed the 60-second application limit on CPU-only machines.

The loopback address refers to the backend host, not the user's browser. A backend hosted on Render cannot reach Ollama running on your laptop through this address. Use a hosted endpoint in that case. This package's validation used a local mock inference server; Ollama model download, creation, hardware requirements, and real model quality were not exercised in the cloud workspace.

## Option B: hosted OpenAI-compatible inference

Set `AI_ENABLED=true`, `AI_BASE_URL` to your provider's HTTPS API base (commonly ending in `/v1`), `AI_MODEL` to a model available to your account, and `AI_API_KEY` through your server's secret settings. The client appends `/chat/completions` to the base URL. Do not include that suffix twice.

The model must support system/user messages, non-streaming Chat Completions, JSON object output (`response_format`), `temperature`, and `max_tokens`. Providers/models that require a different API or parameter set need a separate adapter. Network settings must permit the exact provider hostname. A provider may charge for generation; requests are bounded to 8,192 output tokens and ten requests per user per fifteen minutes by default.

Remote inference requires HTTPS and an API key. Provider URLs and keys are operator-controlled, never accepted from browser requests. Redirects are refused. Only enable a provider you trust to receive the selected source files and instructions.

## Review and apply

1. Sign in, select a project, and choose **Open Selected**.
2. Open and save a source file, then choose **Add open file** in the Pusher AI section. Repeat for up to six relevant files.
3. Describe the requested edit and choose **Generate edits**. The model receives the latest saved copies of those files and your instruction.
4. Read the summary and compare **Before** with **Proposed replacement** for every file.
5. Choose **Apply edit** for an accepted file or **Discard**. Apply uses the same snapshot, persistence, ownership, and version checks as the editor. Save or discard any manual editor draft first.
6. Run the project's relevant tests, inspect the resulting code, and use **Push Selected** when ready to publish.

Applying several files is a sequence of separate saves, not an atomic transaction. If a later apply fails, earlier accepted files remain saved. Each apply makes the existing before-save snapshot. Closing/switching the project clears proposals in this tab. Proposals are not stored in the database. Cancelling generation applies nothing, although a provider may have already performed billable work.

If a file changes after generation, its old proposal is rejected with `FILE_CHANGED`; generate a new one. No proposal automatically runs commands, installs dependencies, commits, pushes, or executes tests. The existing background sync only pulls remote changes and preserves local edits.

## Scope and limits

- Existing regular UTF-8 files only; no creation, deletion, renaming, links, binary files, or whole-repository autonomous search.
- One to six explicitly selected files; 48 KiB combined input including paths and instruction; instruction maximum 4,000 characters.
- At most 96 KiB of replacement content and 192 KiB of provider response; truncated or malformed output is rejected.
- A maximum 60-second inference timeout, plus the application's existing workspace restoration timeout and concurrent job limits.
- Common secret filenames (`.env*`, private keys, credential directories) are blocked. Filename filtering cannot detect every embedded secret: inspect ordinary source files and instructions before sharing them.
- Output is rendered as text. Proposed code can still be incorrect or unsafe; review and test it before application or publication.

## Troubleshooting

**AI is disabled:** set `AI_ENABLED=true` and a valid model, then restart the backend. **Check configuration** reports server configuration, not a successful inference probe.

**Provider error:** verify the endpoint, available model, network access, account quota, and API compatibility. Provider error bodies are intentionally not returned to the browser.

**Invalid proposal:** retry with fewer/smaller files or a narrower instruction. The model must return a JSON object with a `summary` string and `changes` array. Each change requires exactly `path`, full replacement `content`, and `explanation`. Only selected paths are accepted.

**Timeout:** reduce context or use faster inference. `AI_TIMEOUT_MS` accepts integers from 1,000 to 60,000 milliseconds. Global and per-user work limits prevent abandoned requests from accumulating unrestricted work.

## Validation

```sh
npm run test:syntax
npm test
node scripts/verify-project.mjs
git diff --check
```

The automated tests use a real HTTP mock of inference and the existing mocked Supabase service. They exercise source selection, authentication, ownership, origin checks, rate limits, output validation, timeouts, read-only proposals, explicit saves, and stale-version rejection. They do not establish real-model quality or live provider/account connectivity.
