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
| CodebaseSearch | Find the code that answers a question across the project, by meaning and by names, from the codebase index |
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

`/clear`, `/compact [focus]`, `/init`, `/review`, `/model`, `/plan`, `/spec <what to build>`, `/memory`, `/memories`, `/skills`, `/agents`, `/mcp`, `/context` and `/help`, plus your own commands and skills.

## Spec mode

For bigger features, `/spec <what to build>` or **Agent: New Spec...** has the agent plan before it codes, in three documents under `.nighthawk/specs/<name>/` that you approve one at a time:

1. **requirements.md**: user stories with acceptance criteria ("WHEN ... THEN the system SHALL ...").
2. **design.md**: the architecture, components, files, data and error handling, based on the code as it is.
3. **tasks.md**: a numbered checklist of small coding steps that build the design.

Buttons at the top of each document approve it (and have the agent write the next one) or ask for changes; you can also edit the documents yourself before approving. Until the tasks are approved, the agent can only change files in the spec's folder. Then each open task in tasks.md gets a **Start Task** button, and **Run All Open Tasks** works through them in order; the agent ticks off each task when it is done. **Agent: Open Spec...** lists the specs and how far each one got. Specs are plain Markdown, so you can commit them with the code.

## Memories

The agent remembers what it learns across conversations: your preferences ("prefers pnpm", "wants short answers") for every project, and facts about this project ("tests run with `npm run test:unit`") for this workspace. It saves one with its Memory tool when you tell it something worth keeping, or when it finds out something a later conversation would need, and a card in the conversation shows what it saved. Every conversation starts with the memories in its instructions, and the agent updates or deletes ones that turn out wrong.

**Agent: Show Memories...** or `/memories` lists them to edit, forget or add one by hand. Memories are kept in Nighthawk's storage on your computer, never in the project, and things that look like keys or passwords are never saved. Turn them off with `nighthawk.agent.memories`.

## External agents

The agent panel can also run other coding agents through the [Agent Client Protocol](https://agentclientprotocol.com): **Agent: New Conversation With...**, or click the model name in a conversation, then pick **Claude Code**, **Gemini CLI** or **Codex**. The conversation looks and works like one with the Nighthawk Agent: its messages, thinking, plan and tool calls show as cards, edits as diffs, and it asks for approval in the panel. File reads and writes go through the editor, so it sees unsaved changes, and every message gets a checkpoint you can restore. The permission modes switch the agent's own modes, and its own slash commands appear in the `/` menu.

These agents run as programs on your computer through `npx`, so they need [Node.js](https://nodejs.org), and each uses its own sign-in or API key (for example a Claude subscription or `ANTHROPIC_API_KEY`); Nighthawk does not count their usage. Add any other agent that speaks the protocol in `nighthawk.agent.externalAgents`:

```json
"nighthawk.agent.externalAgents": [
	{ "name": "My Agent", "command": "my-agent", "args": ["--acp"], "env": { "MY_AGENT_KEY": "..." } }
]
```

## Conversations

Conversations are saved per workspace; open them from the history button. Long conversations are compacted automatically near the model's context limit.

## Checkpoints

Each time you send a message, the agent first saves a checkpoint of your files, so when a run of new features breaks things you can take the code back to how it was when it still worked.

- A **Checkpoint 10:32** line sits above every message. Click it to see which files differ, then pick **Restore Code** (files only), **Restore Code and Conversation** (also removes that message and everything after it, and puts the message back in the input box), or **Conversation Only**.
- **Agent: Restore Checkpoint...** lists every checkpoint of the workspace from all conversations, newest first ("30 minutes ago"), even after the conversation was cleared or compacted.
- A restore is undoable: press **Undo Restore** in the conversation, or run **Agent: Undo Checkpoint Restore**.

A checkpoint holds the whole folder as it was, your own edits included, not only what the agent changed. Files are compared with a separate Git store in Nighthawk's storage, so your project's commits, branches and staged changes are never touched. Files your `.gitignore` excludes, folders such as `node_modules` and new files over 25 MB are left out, and stay as they are on restore. Unsaved editors are saved before a restore so that Undo can bring them back. Checkpoints need Git; turn them off with `nighthawk.agent.checkpoints`.

## Inline edit

Select code and press `Ctrl+I` (`Cmd+I` on macOS), or pick **Edit Inline...** from the editor's context menu, then say what to change. A box opens above the code, and the new code streams straight into the file. When it is done, the lines it replaced show in red above the new ones, which are highlighted in green.

- **Accept** (`Ctrl+Enter`) keeps the new code; **Reject** (`Ctrl+Backspace`) puts the old code back. When the model changed several places, each one has its own Accept and Reject above it.
- Type a follow-up in the box, such as "also handle null", to have the model refine its answer.
- With nothing selected, `Ctrl+I` writes new code at the cursor.
- `Escape` stops the model while it writes; `Up` in the box brings back earlier requests.

Inline edits use the agent's model unless **AI: Select Model for Inline Edits...** (`nighthawk.inlineEdit.model`) picks another; a fast model makes them feel instant. They are counted on the usage page like other AI requests.

## Autocomplete

While you type, the model suggests what comes next as grey text: the rest of a line, or a whole block on an empty line or after `{`. `Tab` accepts it, `Ctrl+Right` (`Cmd+Right` on macOS) accepts one word, `Escape` hides it and `Alt+\` asks for one right away. When the suggestion list is open, the grey text goes on from the selected item: the first `Tab` takes the item, the second the rest.

- A request goes out once typing pauses for 300 ms (`nighthawk.autocomplete.delay`). Typing the start of a suggestion keeps showing the rest without asking again.
- The **Autocomplete** item in the status bar shows when a suggestion is on its way or the last one failed. Click it to turn autocomplete off, everywhere or for the current language, or to change its model.
- It is off for plain text, Markdown and the commit message box by default (`nighthawk.autocomplete.disabledLanguages`). Files that usually hold secrets, such as `.env` and key files, are never sent.

**Next edits.** Where there is nothing to complete at the cursor, autocomplete predicts your next edit from your recent ones in the file: after you rename a parameter, it offers the same rename at its next use; after you add an argument, the next call that needs it. The editor marks the place, `Tab` jumps there and `Tab` again accepts, so a rename across a function is a few presses of `Tab`. `Escape` turns a suggestion down, and it is not offered again. Turn next edits off from the Autocomplete menu or with `nighthawk.autocomplete.nextEdits`; they are counted on the usage page under Next edits.

Autocomplete uses its own model when **AI: Select Model for Autocomplete...** (`nighthawk.autocomplete.model`) sets one, else the inline edit model, else the agent's. Every pause in typing can send a request, so pick a small, fast model; a local model through Ollama or LM Studio costs nothing. Requests are counted on the usage page under Autocomplete.

## Codebase index

Nighthawk keeps an index of the workspace's code on your computer, so the agent can find code by what it does rather than only by exact text: "where do we handle sign-in?" finds `signIn` even when the question shares no word with the code. The agent uses it through its CodebaseSearch tool; **AI: Search Codebase...** searches it yourself.

- The index splits files into chunks of about 40 lines, cut where functions and classes start. It ranks them by words and names (identifiers are split, so `parseUserToken` matches "user token") and, with an embedding model, by meaning. Both rankings are merged.
- It follows `.gitignore`, plus `.nighthawkignore`, `.cursorignore` and `.aiignore` for files you want to keep away from AI, and `nighthawk.index.exclude`. Files that usually hold secrets (`.env`, key files), lock files, binaries and minified code are never indexed, and things that look like keys or passwords are removed before code is sent for embedding.
- It updates within seconds as files change, and is saved, so reopening a project only rereads changed files.
- The database icon in the status bar shows progress; click it to search, rebuild the index, choose the embedding model or turn indexing off.

**Embedding models.** Finding code by meaning needs an embedding model, which `nighthawk.index.embeddingModel` picks automatically from your endpoints: OpenAI (`text-embedding-3-small`), Gemini, Mistral, Voyage, or an embedding model installed in Ollama or LM Studio (for example `ollama pull nomic-embed-text`). Local models are used right away and cost nothing. Before code goes to a cloud model you did not pick yourself, Nighthawk asks once and says what it costs; after that only changed files are sent. Anthropic has no embedding models, so with only an Anthropic endpoint the index ranks by words and names, and the agent adds likely names and synonyms to its searches. Embedding requests are counted on the usage page under Codebase index.

## Terminal assistant

Press `Ctrl+I` (`Cmd+I` on macOS) in a terminal, or use the sparkle button in the terminal's title bar, and describe what you want to do in plain English. The model suggests one command for your shell and operating system, with what it does; run it, insert it to edit first, or copy it. Commands that delete, overwrite, force-push or run downloaded code are flagged and ask again before they run.

When a command fails, the lightbulb next to it offers **Explain with the Agent**, which sends the command and its output to the agent panel to find the cause and the fix. **Terminal: Explain Last Error with the Agent** does the same from the Command Palette. Both need shell integration, which is on by default for bash, zsh, fish and PowerShell.

## Development

```sh
npm test                      # unit tests (Node's test runner, no install needed)
node ./esbuild.webview.mts    # bundle the chat page into media/agent.js
```

`src/core` has no editor dependencies (providers, agent loop, tools, permissions, hooks, MCP client). `src/host` connects it to the editor, and `webview-src` is the chat page.
