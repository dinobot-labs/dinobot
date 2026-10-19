# Models, reasoning and provider accounts

Source: src/commands/builtin.ts, src/commands/reasoning.ts, src/commands/fast.ts, src/core/threads.ts,
src/core/native-model-commands.ts, src/auth/index.ts, src/auth/store.ts, src/main.ts, src/manifest.ts,
openwiki/decisions/0044-thread-local-native-model-controls.md, 0045-multi-account-credential-rotation.md.

## Which model a conversation uses

Precedence matters. Get it right before you answer "how do I change the default model?".

1. **An existing conversation keeps its own model.** Each thread stores its model on creation. Later default changes do not rewrite it.
2. **A new conversation** takes the **saved model preference** if one exists. Otherwise it takes the manifest's `bot.model` (`preference.model ?? model` in `src/core/threads.ts`).
3. The saved preference is written by the local `/model` command (TUI, client API, and channels that use the local command registry) and is stored in `<dataDir>/dinobot.sqlite`. Native messenger model commands (Telegram topic `/model`, Discord native command, Slack `@bot /model`) change **only that thread/topic**. They do **not** save a global preference (ADR 0044, `persistDefault: false`).

Consequence: once someone has used `/model` locally, editing `bot.model` in `dinobot.yaml` no longer changes the model of new conversations. The saved preference wins. Use `/model` again to change it.

## Recipes

### Change the default model (recommended)

In the TUI (or any surface with local slash commands):

```
/model                      # picker of available models (logged-in providers only)
/model anthropic/claude-sonnet-4-6   # switch directly: provider/modelId
```

This switches the current thread **and** saves the choice as the default for new conversations. It also saves the resulting reasoning level. No restart is needed. Errors:
- `unknown model <ref>`: the id is not in the model catalog.
- `model <ref> is not available; log in to <provider> first`: run `/login` first.

### Change the boot default in the manifest

```yaml
bot:
  model:
    provider: anthropic        # provider id, e.g. anthropic | openai | ...
    modelId: claude-sonnet-4-6
```

The manifest is read at process start. Restart the daemon (`dinobot serve`, or the background daemon the TUI started) for the change to apply. This value is used only when no saved `/model` preference exists, and only for new conversations.

### Change the model for one messenger thread only

Telegram (inside the topic): `/models` lists models and `/model <provider/modelId>` switches. Discord: the registered native `/model` command in that thread. Slack: `@bot /model <provider/modelId>` in the thread. These never change the global default. `commands.disabled: [model]` disables them as well.

## Reasoning effort and fast tier

- `/reasoning [level|cycle]`: choose the reasoning effort for this thread **and** save it as the default.
- `/fast [on|off|toggle]`: priority service tier (faster, costs more) where the model supports it. Also saved as the default.
- A model switch adjusts the reasoning level to one the new model supports.

## Provider accounts (credentials)

- `/login` lists providers and stores the credential (OAuth or API key) in `<dataDir>/auth.json` (mode 0600). Never put keys in `dinobot.yaml`.
- Alternatively, API-key providers fall back to their environment variable (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) **in the daemon's environment** when no credential is stored; a stored credential wins. Details in cli-and-daemon.md.
- Endpoints that speak the OpenAI Chat Completions API but are not builtin (routers, gateways, self-hosted servers) are added under `providers:` in `dinobot.yaml` (configuration.md §2.12). They then appear in `/login` and `/model` like any provider; the key comes from `/login <id>` or the `<ID>_API_KEY` environment variable, never from the manifest.
- Login-only providers marked "no model transport in this build" can store credentials but cannot serve chat models.
- `/accounts` shows the stored accounts. With several accounts for one provider, dinobot **rotates on rate/usage limits** (ADR 0045).
- `/logout` removes one account or all accounts of a provider.
- `/model` only lists models of providers you have logged in to. "No models available. Run /login to connect a provider." means no credentials are stored yet.

## Answering checklist

- Ask or check whether the user wants to change (a) only this thread, (b) the default for new conversations, or (c) the boot config.
- For (b), recommend `/model`. Mention that existing threads keep their model. Start a new conversation to see the change: in the TUI, `dinobot` opens a new session each time.
- For (c), mention the precedence caveat above and the restart.
