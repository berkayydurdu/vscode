# Nighthawk Agent

A coding agent built into Nighthawk, in the spirit of Claude Code. It reads your code, edits files, runs commands and asks before anything risky. It works with any model you connect: Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek, Mistral, Groq, xAI, a local Ollama or LM Studio, or any OpenAI-compatible or Anthropic-compatible API.

Open it with **Ctrl+Escape** or the sparkle icon in the secondary side bar.

## Connecting a model

Run **AI: Add Model Endpoint**, pick a provider, paste a key and choose models. Keys are stored in the OS keychain (Windows Credential Manager, macOS Keychain, libsecret on Linux), never in settings. If no key is stored, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` from the environment is used.

Endpoints live in the `nighthawk.ai.endpoints` setting and can be edited by hand:

```json
"nighthawk.ai.endpoints": [
	{ "name": "Anthropic", "provider": "anthropic", "baseUrl": "https://api.anthropic.com", "models": ["claude-opus-5-5", "claude-sonnet-5-5"] },
	{ "name": "Ollama", "provider": "openai", "baseUrl": "http://localhost:11434/v1", "models": ["qwen3-coder"], "contextWindow": 131072 }
],
"nighthawk.ai.model": "Anthropic/claude-opus-5-5"
```

Switch models from the status bar, the model chip in the panel, or `/model`.

## Tools

The agent has the same tool set as Claude Code, so models trained on it feel at home:

| Tool | What it does |
|---|---|
| Read, LS, Glob, Grep | Read files and search the workspace (Grep uses the bundled ripgrep) |
| Edit, MultiEdit, Write | Change files. A file must be read before it is edited, and stale edits are rejected |
| Bash, BashOutput, KillBash | Run commands, including background ones. On Windows it uses Git Bash when installed, else PowerShell |
| TodoWrite | Keep a task list, shown above the input |
| Task | Hand work to a sub-agent (general-purpose, Explore, Plan, or your own) |
| WebFetch | Read a web page |
| Skill | Load a skill's instructions |
| AskUserQuestion, ExitPlanMode | Ask you a question, or present a plan for approval |
| Diagnostics | Read errors and warnings from the editor's language services |
| `mcp__server__tool` | Tools from your MCP servers |

## Permission modes

Press **Shift+Tab** in the input to cycle:

- **Ask before edits**: reads run freely; edits and commands ask first. Read-only commands such as `ls`, `git status` or `git diff` run without asking.
- **Auto-accept edits**: edits in the workspace run freely; commands still ask.
- **Plan mode**: read only. The agent researches and proposes a plan, then asks to start.
- **Full auto**: everything runs without asking.

When a tool asks, you can allow it once, always allow it (saved as a rule), deny it, or tell the agent what to do instead. Rules use Claude Code syntax in `nighthawk.agent.permissions.allow` and `nighthawk.agent.permissions.deny`, or in a project's `.nighthawk/settings.json` or `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(npm test:*)", "Edit(src/**)", "WebFetch(domain:docs.python.org)"], "deny": ["Bash(git push:*)"] } }
```

## Project setup

The agent reads these from the workspace (only in trusted workspaces) and from `~/.nighthawk`:

- **Instructions**: `AGENTS.md`, `NIGHTHAWK.md` or `CLAUDE.md`. `/init` writes one for you, `/memory` opens it.
- **Skills**: `.nighthawk/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`.
- **Slash commands**: `.nighthawk/commands/<name>.md` or `.claude/commands/<name>.md`, with `$ARGUMENTS` and `$1`...`$9`.
- **Sub-agents**: `.nighthawk/agents/<name>.md` or `.claude/agents/<name>.md`.
- **Hooks**: `hooks` in a settings file, with the events PreToolUse, PostToolUse, UserPromptSubmit, SessionStart and Stop. Exit code 2 blocks, as in Claude Code.
- **MCP servers**: `.mcp.json`, `.nighthawk/mcp.json`, `.vscode/mcp.json`, `~/.nighthawk/mcp.json` or the `nighthawk.agent.mcpServers` setting. Servers from a project ask for your approval before they start.

## Slash commands

`/clear`, `/compact [focus]`, `/init`, `/review`, `/model`, `/plan`, `/memory`, `/skills`, `/agents`, `/mcp`, `/context` and `/help`, plus your own commands and skills.

## Conversations

Conversations are saved per workspace; open them from the history button. Hover a message and press the rewind button to go back to before it: the files the agent changed since then are restored. Long conversations are compacted automatically near the model's context limit.

## Terminal assistant

Press `Ctrl+I` (`Cmd+I` on macOS) in a terminal, or use the sparkle button in the terminal's title bar, and describe what you want to do in plain English. The model suggests one command for your shell and operating system, with what it does; run it, insert it to edit first, or copy it. Commands that delete, overwrite, force-push or run downloaded code are flagged and ask again before they run.

When a command fails, the lightbulb next to it offers **Explain with the Agent**, which sends the command and its output to the agent panel to find the cause and the fix. **Terminal: Explain Last Error with the Agent** does the same from the Command Palette. Both need shell integration, which is on by default for bash, zsh, fish and PowerShell.

## Development

```sh
npm test                      # unit tests (Node's test runner, no install needed)
node ./esbuild.webview.mts    # bundle the chat page into media/agent.js
```

`src/core` has no editor dependencies (providers, agent loop, tools, permissions, hooks, MCP client). `src/host` connects it to the editor, and `webview-src` is the chat page.
