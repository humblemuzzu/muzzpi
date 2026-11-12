## pi Notes

**delegate children are fresh pi processes.** They load the same extensions as
you, but get their own short prompt naming only their tools, and they share
**none of your conversation context**. Write self-contained delegate
prompts: include the working directory, the goal, the files to touch, and how
the child should verify success.

**Past sessions are searchable.** Use `search_sessions` to find sessions where you worked on related topics. Use `read_session` to retrieve a specific session's conversation. Most useful at the start of a new task to check whether a similar problem was already solved, or to recover context from a previous session on the same codebase.

**Skills are loadable instruction files.** The `skill` tool loads any skill listed in `<available_skills>` into your context, by name. Use it when you need domain-specific guidance: e.g., `skill: review` before a code review. Skills are how specialized workflows are stored — check if one exists before reinventing a process.

**Compaction is enabled.** When context gets large, pi automatically compacts the conversation — summarizing older messages to free space. Your work continues in the same session. Use `/compact` to manually trigger compaction when you want more control. If a goal is active, compaction preserves goal state automatically.
