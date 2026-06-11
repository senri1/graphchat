# Conversation Context

This directory is maintained by GraphChat Codex.

## How to search

- Start with `INDEX.md` to find likely chats.
- Search full node text with `rg -n "query" chats/*/nodes`.
- Read a chat's `README.md` for its preview and basic statistics.
- Read `graph.json` only when parent/child relationships, branches, or Codex checkpoints matter.

## Editing rules

- Files under `nodes/documents/` are user-authored Markdown documents and may be edited.
- Files under `nodes/conversation/` are immutable conversation messages. Do not edit them.
- Do not edit `graph.json`, `README.md`, or `INDEX.md`; GraphChat regenerates them.
- When citing context, include the chat id and node id or the node file path.
