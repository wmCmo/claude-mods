# claude-mods

Two small Claude Code mods.

| Mod | What it does |
|---|---|
| **context-bar** | A band above the prompt showing context usage and the weekly usage limit. Each finished turn gets a line with the context added, cost, and input/output tokens. After a compaction, the summary can be opened in a pane. Works in the terminal and the desktop app. |
| **compact-pickup** | `/compact-pickup`: compacts the conversation, then runs `/pickup`. It expects a `pickup` skill in `~/.claude/skills/`. |

## Install

In a terminal session, type at the prompt:

```
/plugin install context-bar --marketplace wmCmo/claude-mods
/plugin install compact-pickup --marketplace wmCmo/claude-mods
```

Answer `y` to add the marketplace, then choose a scope (user scope = every session).

From a shell instead:

```
claude plugin install context-bar --marketplace wmCmo/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `wmCmo/claude-mods`, then **Add plugin**.
