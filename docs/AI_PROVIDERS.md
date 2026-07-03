# AI Providers — bring your own key

Fission never proxies your prompts through anyone's servers. The Rust core calls your chosen provider directly with your key, which lives in the Windows Credential Manager (service `FissionMail`). Keys are write-only over IPC, never logged, never in errors, never in the repo.

Configure everything in **Settings → AI Providers**: paste a key, pick the default provider (radio), adjust the model, and hit **Test connection**.

## Claude (default)

1. [console.anthropic.com](https://console.anthropic.com) → *API Keys* → Create key (`sk-ant-…`).
2. Endpoint: `POST https://api.anthropic.com/v1/messages` with SSE streaming, headers `x-api-key` + `anthropic-version`.
3. Default model `claude-sonnet-5` (configurable — any Messages-API model works).
4. Multimodal: image attachments are passed as base64 blocks.

## OpenAI

1. [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → Create key (`sk-…`).
2. Endpoint: `POST https://api.openai.com/v1/chat/completions`, streaming.
3. Default model `gpt-5.2` (configurable).
4. Multimodal: image attachments passed as data-URL `image_url` blocks.

## NVIDIA NIM

NIM speaks the OpenAI API, so Fission reuses the OpenAI adapter with a configurable **base URL**:

- **Hosted:** [build.nvidia.com](https://build.nvidia.com) → pick a model → *Get API Key* (`nvapi-…`). Base URL `https://integrate.api.nvidia.com/v1`, model e.g. `meta/llama-3.3-70b-instruct`.
- **Self-hosted:** point the base URL at your NIM container, e.g. `http://your-host:8000/v1`.
- Images are not sent to NIM (model support varies); attachments still contribute extracted text.

## What the model sees (and doesn't)

Per request, the Context Assembler sends: the thread transcript (oldest quoted trails trimmed first under a ~25k-token budget), extracted attachment text (PDF, plain text, best-effort .docx; capped), image attachments for multimodal providers, your Knowledge Base (instructions, snippets, voice examples), and your instruction. Nothing is stored provider-side by Fission; retention is governed by your provider agreement.

## Behavior when a key is missing

- Instant Replies simply don't appear.
- `Ctrl+J`, `?`, and Test connection show: *"No API key saved for <provider>. Add one in Settings → AI Providers."*
- Everything non-AI keeps working.

Rate limits are retried with exponential backoff (3 attempts) and then surfaced as a plain-language error.
