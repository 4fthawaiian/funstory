# FunStory

Turn any Wikipedia page into an interesting narrative.

Built with **Flutter** frontend and **Node.js/Express** backend.

## What it does

1. Paste a Wikipedia URL or page title into the Flutter app.
2. The Node backend fetches the article.
3. An LLM rewrites it as a vivid, readable story — streamed word-by-word to the app.

## Supported LLM providers

- **OpenAI** (`openai`) — set `LLM_API_KEY` and pick a model like `gpt-4o-mini`.
- **Anthropic** (`anthropic`) — set `LLM_API_KEY` and pick a model like `claude-3-5-sonnet-20241022`.
- **Ollama** (`ollama`) — run a local model; defaults to `http://localhost:11434/v1`.
- **OpenRouter** (`openai` provider + `LLM_BASE_URL=https://openrouter.ai/api/v1`) — use any model OpenRouter exposes, including free-tier ones.

## Project layout

```
funstory/
├── server/            # Node.js backend
│   ├── index.js       # Express routes
│   ├── wiki.js        # Wikipedia fetching
│   ├── narrative.js   # LLM streaming
│   ├── package.json
│   └── .env.example
├── funstory_flutter/  # Flutter frontend
│   └── lib/main.dart
└── README.md
```

## Backend setup

```bash
cd server
npm install

# Configure your LLM
cp .env.example .env
# Edit .env with your provider, API key, and model

npm start
```

The server runs on `http://localhost:8765` by default.

## Frontend setup

```bash
cd funstory_flutter
flutter pub get
flutter run
```

For web:

```bash
flutter run -d chrome
```

If running on a device or emulator, update the backend URL in the app's **Backend settings** to point at your machine's IP (e.g. `http://192.168.1.5:8765`).

## Using OpenRouter (including free models)

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-...
# Comma-separated list = fallback chain; first available model wins.
# Avoid the openrouter/free router itself — it can route to safety
# classifiers that respond with things like "User Safety: safe".
LLM_MODEL=google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,poolside/laguna-s-2.1:free
```

Optional telemetry headers:

```env
OPENROUTER_REFERER=http://localhost
OPENROUTER_TITLE=FunStory
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai`, `anthropic`, or `ollama` |
| `LLM_API_KEY` | — | API key for OpenAI/Anthropic/OpenRouter |
| `LLM_MODEL` | `gpt-4o-mini` | Model name; comma-separated list acts as an OpenRouter fallback chain |
| `LLM_BASE_URL` | — | Optional override, e.g. `https://openrouter.ai/api/v1` |
| `OPENROUTER_REFERER` | `http://localhost` | Referer header sent to OpenRouter |
| `OPENROUTER_TITLE` | `FunStory` | App title header sent to OpenRouter |
| `PORT` | `8765` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |

## Development tips

- Use `npm run dev` in the server folder to auto-restart on changes.
- Point the app at a different backend with the `?backend=` URL param (e.g. `/?backend=http://192.168.1.5:8765`), or the gear icon on the landing screen.
- If you don't have an LLM API key, install [Ollama](https://ollama.com) and run a model like `llama3.2`, then set `LLM_PROVIDER=ollama`.
