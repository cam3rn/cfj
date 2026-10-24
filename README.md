<div align="center">
  <h1>Claude caching proxy for JanitorAI</h1>
  <p>Prompt caching + 5.x-model compatibility between JanitorAI and the Anthropic API</p>
</div>

<hr />

- [What it does](#what-it-does)
- [Deploying on Render](#deploying-on-render)
- [Setting up JanitorAI](#setting-up-janitorai)
- [Checking that it saves money](#checking-that-it-saves-money)
- [Settings](#settings)
- [Running locally / other hosts](#running-locally--other-hosts)
- [Troubleshooting](#troubleshooting)

## What it does

JanitorAI sends your whole chat (character card, persona, every message so far) to the model on
every single turn, and Anthropic bills all of it as fresh input every time. This proxy sits in
between and adds **prompt-caching breakpoints** (`cache_control`) so that everything except your
newest message is read from Anthropic's cache instead. Cached input costs **10%** of the normal
price (5% on Opus 5.5 / Sonnet 5.5, 2.5% on Fable 5.1), so in a long roleplay the input side of
your bill typically drops by **80–90%**. Output tokens cost the same as before.

It also makes JanitorAI work with the current **5.x models** at all: Opus 5.5, Sonnet 5.5,
Haiku 5.5 and Fable 5.1 reject the `temperature` setting JanitorAI always sends (and a few other
things) with an error. The proxy strips what the model will not accept, keeps thinking on the cheap
`low` effort level for roleplay, and leaves room in `max_tokens` so replies don't get cut off before
any text appears.

Zero dependencies, one file, runs on Render's free tier.

## Deploying on Render

You need a Render account (free tier is fine) and a copy of this repository on GitHub.

### 1. Get the code onto GitHub

If you are reading this on GitHub already, skip ahead and use this repo's URL.

Otherwise: sign in to GitHub → **+** (top right) → **New repository** → name it
`janitor-claude-cache-proxy`, keep it **Public**, press **Create repository**. On the empty-repo
page click **uploading an existing file**, open the unzipped project folder and drag **the files
inside it** (not the folder itself) into the upload box — `server.js`, `package.json`, `render.yaml`,
`README.md`, `Dockerfile` and the `test` folder — then press **Commit changes**. `render.yaml` must
end up at the top level of the repo, next to `server.js`; if it lands inside a subfolder Render won't
find it and won't ask for your keys. Copy the repo URL, e.g.
`https://github.com/YOUR-USERNAME/janitor-claude-cache-proxy`.

> If you keep the repo private, connect your GitHub account to Render when it asks and pick the
> repo from the list instead of pasting a URL. Everything else is the same.

### 2. Create the Blueprint

1. Sign in to https://dashboard.render.com. If you see a "what do you want to deploy" screen, press **Skip**.
2. In the left sidebar go to **Blueprints** → **New Blueprint Instance**.
3. Paste the repo URL into **Public Git Repository** and press **Continue**.
4. Put `claude-cache-proxy` (or anything) into **Blueprint Name**.
5. Render reads `render.yaml` and **asks you for two values**:

   | Variable | What to put in |
   |---|---|
   | `ANTHROPIC_API_KEY` | Your Anthropic key from https://console.anthropic.com/settings/keys (starts with `sk-ant-`). It stays on Render; JanitorAI never sees it. |
   | `PROXY_KEY` | A password **you make up** — long and random, e.g. `k9Tq-w3Lm-8vZp-Qa2r`. This is what you'll type into JanitorAI's *API key* field. Anyone who has it can spend on your Anthropic key. |

   If either box is missing, your `render.yaml` didn't upload: check that it is in the root of the repo.
6. Press **Apply** / **Deploy Blueprint**. The first deploy takes a minute or two.
7. Back on the dashboard, click the **claude-cache-proxy** service. Its URL is at the top, like
   `https://claude-cache-proxy-abcd.onrender.com`. Open it in a browser — you should see
   **"Claude caching proxy ● running"** with the exact values to type into JanitorAI. If the page
   shows a yellow *"Configuration needs attention"* box, it tells you which variable to fix.

Both values can be changed later under the service's **Environment** tab (then **Manual Deploy →
Deploy latest commit**, or just wait for the automatic restart).

<details>
<summary>Prefer to put your Anthropic key straight into JanitorAI instead of on Render?</summary>

Leave both prompted values empty (if Render insists on a value, type anything and delete both
variables afterwards in the Environment tab). The proxy then runs in *bring-your-own-key* mode:
whatever `sk-ant-…` key JanitorAI sends is forwarded to Anthropic. Only keys starting with
`sk-ant-` are accepted, so nobody can use your proxy with junk.
</details>

## Setting up JanitorAI

The proxy's landing page shows these with your real URL filled in.

1. Open any chat → menu (top right) → **API Settings** → **Proxy** → **Add Configuration**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Configuration name | anything, e.g. `Claude (cached)` |
   | Model | `claude-sonnet-5-5` — or `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` |
   | Proxy URL / Other API URL | `https://YOUR-APP.onrender.com/v1/chat/completions` |
   | API key | the **`PROXY_KEY`** you made up (or your `sk-ant-…` key in bring-your-own-key mode) |

   If your JanitorAI version has separate *Base URL* and *Endpoint* boxes, use
   `https://YOUR-APP.onrender.com/v1/` and `chat/completions`. If it offers an explicit
   *Claude / Anthropic* format option, use `https://YOUR-APP.onrender.com/v1/messages` instead.
   The bare URL `https://YOUR-APP.onrender.com` also works.
3. Press **Save** (pressing it twice helps with JanitorAI's occasional "network error"), then **Save Settings**.
4. **Reload the JanitorAI page** — it caches old proxy settings — make sure the configuration is **Active**, then press **Test**.
   You should get *"Valid API Key. Configuration works!"*. If not, the error text says what's wrong
   (wrong `PROXY_KEY`, bad model name, Anthropic key rejected, no credit…).
5. Keep **Streaming** on in Generation Settings.

## Checking that it saves money

Render → your service → **Logs**. Every message prints one line:

```
[usage key=…proxy] claude-sonnet-5-5 | input 9342 = cached 9000 (96%) + newly-cached 300 + uncached 42 | output 180 | this turn: $0.0021 instead of $0.0187 | saved so far ≈ $0.31 | breakpoints: system, msg[14/15] (trailing=1) | compat: dropped temperature, effort=low, max_tokens +1024 for thinking
```

* **cached** — tokens read from cache (the cheap ones). From the second message of a chat this
  should be nearly everything.
* **newly-cached** — tokens written to cache this turn (normally the previous reply + your new message).
* **trailing=N** — how many re-injected trailing blocks (jailbreak / custom prompt) the proxy
  detected and is keeping *outside* the cached prefix. `unknown` on the first message is normal.
* **compat** — what was adjusted for the model.

`https://YOUR-APP.onrender.com/stats` shows running totals; the landing page shows a summary.

### How the breakpoints are placed (why this isn't just "turn on caching")

Anthropic only writes a cache entry at the exact block you mark, and only re-uses it when a later
request has an identical prefix ending at a marked spot. Roleplay front-ends re-inject something at
the **end** of every request that is not part of the saved history (a jailbreak / custom prompt
block). Mark that, and you write an entry no later request can ever hit — which is what Anthropic's
own top-level "automatic caching" would do here.

So the proxy (1) always marks the end of the system prompt, (2) watches a couple of turns to work
out how many trailing blocks JanitorAI re-injects and marks the last *real* history message instead,
and (3) on the first turn of a chat marks the last three messages so the real end-of-history gets a
cache write whichever one it is. Breakpoints are free; you only pay for actual writes and reads.

## Settings

All are environment variables on Render (service → **Environment**).

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Server-side Anthropic key. Needs `PROXY_KEY` too, otherwise it is ignored (the page warns you). |
| `PROXY_KEY` | – | Password clients send as their API key to use the server-side key. |
| `CACHE_TTL` | `5m` | `5m` or `1h`. See below. |
| `EFFORT` | `low` | Thinking depth on 5.x models: `low`, `medium`, `high`, `xhigh`, `max`, or empty for the model's default. Thinking tokens are billed as output, so `low` is the cheap choice for roleplay. |
| `THINKING_HEADROOM` | `1024` | Extra `max_tokens` granted on thinking models so the reply isn't cut off before any text. `0` to disable. |
| `DEFAULT_MAX_TOKENS` | `2048` | Used when JanitorAI sends no / zero max tokens. |
| `PROXY_ADMIN` | – | Shown on the landing page as "hosted by …" (optional). |
| `LOG_REQUESTS` | `true` | Print the per-message usage line. Keys are never logged. |
| `ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` header sent upstream if the client sends none. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Upstream (only for testing). |

### 5-minute vs 1-hour cache (`CACHE_TTL`)

| | `5m` (default) | `1h` |
|---|---|---|
| Cache write price | 1.25× input price | 2× input price |
| Cache read price | same | same |
| Expires after | 5 min without use (each use refreshes it for free) | 1 hour without use |

`5m` is cheapest if you reply within five minutes. If you often pause longer than that mid-chat,
every pause means the whole prompt gets re-written at 1.25× — then `1h` works out cheaper.

## Running locally / other hosts

```
npm start      # listens on :10000 — set the variables from .env.example first
npm test       # 25 end-to-end tests against a mock Anthropic server
```

A `Dockerfile` is included for Railway, Fly.io, Koyeb or a VPS; set the same environment variables.
The free Render tier spins the service down after 15 idle minutes, so the first message afterwards
takes 30–60 s (JanitorAI may show a timeout — just resend). Render's *Starter* plan stays warm; some
people keep a free instance awake with a free uptime monitor pinging `/health` every 10 minutes.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Render didn't ask for `ANTHROPIC_API_KEY` / `PROXY_KEY` | `render.yaml` wasn't in the repo root, or you created a plain Web Service instead of a Blueprint. Add the two variables by hand in the **Environment** tab. |
| Landing page shows *"Configuration needs attention"* | Read the box; it names the variable. Typically one of the two was left empty. |
| JanitorAI Test: `PROXY ERROR 401: Wrong key…` | The API-key field must contain your `PROXY_KEY`, not your Anthropic key (unless you're in bring-your-own-key mode). |
| `PROXY ERROR 401: … Anthropic rejected the ANTHROPIC_API_KEY stored on Render` | The key on Render is wrong / revoked. Fix it in the Environment tab. |
| `PROXY ERROR 404: model: …` | Typo in the Model field. Use e.g. `claude-sonnet-5-5`. |
| `400 … credit balance` | Top up at console.anthropic.com. |
| Replies are blank / `[The reply hit the max-tokens limit…]` | Raise *Max tokens* in JanitorAI's generation settings, or raise `THINKING_HEADROOM`. |
| `cached` is always 0 in the logs | Prompt under the model's minimum cacheable size (512 tokens on 5.x models), or you're pausing longer than `CACHE_TTL` between messages. |
| Cache keeps re-writing every turn (`newly-cached` ≈ whole prompt) | Something above your new message changes each turn: context-size truncation (raise it or start a new chat), an edited card/persona/custom prompt, or a switch of model/settings. |
| *"Network error"* in JanitorAI when saving | JanitorAI quirk: Edit → Save Changes twice, Save Settings, reload, test again. |
