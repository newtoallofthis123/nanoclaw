# Design & Implementation: Project Directory and Clear Command

## Project Directory

### What it does

Each registered group can have an external host directory mounted into its container at `/workspace/project-dir`. When configured, the agent's working directory becomes that path instead of the default `/workspace/group`. This lets a group work on files outside NanoClaw (a wiki, codebase, brain folder, etc.) with full read/write access.

### Configuration

Set `projectDir` in `groups/{name}/config.json`:

```json
{
  "containerConfig": {
    "projectDir": "~/My Drive/brain/brain"
  }
}
```

The path supports `~` expansion. The directory must exist on the host at container spawn time.

### Implementation flow

#### 1. Config loading (`src/index.ts:68-87`)

`applyFileConfig(group)` reads `groups/{folder}/config.json` and merges its `containerConfig` into the group's DB-stored config. File-based values take precedence.

#### 2. Volume mount construction (`src/container-runner.ts:60-115`)

`buildVolumeMounts()` extracts `group.containerConfig?.projectDir`, expands `~` to the home directory, checks `fs.existsSync()`, and creates a `VolumeMount`:

```
hostPath:      /Users/noob/My Drive/brain/brain
containerPath: /workspace/project-dir
readonly:      false
```

If the path doesn't exist, the mount is silently skipped and the agent falls back to `/workspace/group`.

#### 3. Container argument generation (`src/container-runner.ts:225-255`)

Volume mounts are converted to Docker `-v` flags:

```
-v "/Users/noob/My Drive/brain/brain:/workspace/project-dir"
```

#### 4. Agent working directory (`container/agent-runner/src/index.ts:451`)

A `hasProjectDir` boolean flag is passed through the container input JSON. The agent runner uses it to set `cwd`:

```typescript
cwd: containerInput.hasProjectDir ? '/workspace/project-dir' : '/workspace/group',
```

This applies to both regular messages (`src/index.ts:360`) and scheduled tasks (`src/task-scheduler.ts:145`).

### Security

- Group folder names are validated in `src/group-folder.ts` to prevent path traversal and reserved names.
- Additional mounts (separate from `projectDir`) are checked against a security allowlist at `~/.config/nanoclaw/mount-allowlist.json` via `src/mount-security.ts`.
- The allowlist controls which host paths are mountable, whether read-write is permitted, and enforces `nonMainReadOnly` for non-main groups.
- Blocked patterns (`.ssh`, `.gnupg`, `.env`, etc.) provide baseline protection.

### Design decisions

- **Flag propagation over runtime detection**: `hasProjectDir` is computed by the host and passed to the container, rather than having the agent check if `/workspace/project-dir` exists. This keeps the agent logic simple.
- **Silent fallback**: A missing `projectDir` path doesn't error — it falls back to the default. This avoids breaking the group if a drive is unmounted.
- **File config overrides DB**: Operators can customize groups by editing a JSON file without touching the database.

---

## Clear Command

### What it does

When a user sends `/clear` to a registered group, NanoClaw resets the Claude conversation session. The active container is shut down, the session ID is deleted, and on the next message a fresh conversation begins. Message history in SQLite is preserved.

### Trigger

Detected in `src/index.ts:435-447`:

```typescript
const isClear = groupMessages.length === 1
  && groupMessages[0].content.trim().toLowerCase() === '/clear';
```

The check happens before trigger pattern matching, so `/clear` works regardless of the configured assistant name prefix.

### Implementation flow

#### 1. Message detection (`src/index.ts:435-437`)

In the main message loop (polls every 2s), after grouping messages by chat JID, each group's messages are checked. The command is only recognized when it's the sole message in the batch and exactly matches `/clear`.

#### 2. Session deletion (`src/index.ts:439-444`)

Four atomic operations execute in sequence:

| Line | Operation | Effect |
|------|-----------|--------|
| 440 | `delete sessions[group.folder]` | Remove session ID from in-memory map |
| 441 | `deleteSession(group.folder)` | `DELETE FROM sessions WHERE group_folder = ?` in SQLite |
| 442 | `queue.closeStdin(chatJid)` | Write `_close` sentinel file to IPC directory |
| 443-444 | Advance `lastAgentTimestamp`, `saveState()` | Mark `/clear` message as processed |

#### 3. Container shutdown (`src/group-queue.ts:183-194`)

`closeStdin()` writes a sentinel file at `/workspace/ipc/{group_folder}/input/_close`. The container's agent runner polls this directory and exits cleanly when it sees the sentinel (`container/agent-runner/src/index.ts:604-608`). This is a graceful shutdown — no SIGTERM.

#### 4. User confirmation (`src/index.ts:445`)

```typescript
await channel.sendMessage(chatJid, 'Session cleared.');
```

Then `continue` skips normal agent processing for this iteration.

#### 5. Next message starts fresh

When the next message arrives, `sessions[group.folder]` returns `undefined`. The container receives `sessionId: undefined`, the Claude SDK creates a new session, and the new session ID is stored back in both the in-memory map and SQLite (`src/index.ts:369-372`).

### What gets cleared vs preserved

| Cleared | Preserved |
|---------|-----------|
| Session ID (memory + SQLite) | Message history in SQLite `messages` table |
| Active container (graceful shutdown) | Conversation archives in `groups/{name}/conversations/` |
| Container's `.claude/` state | Group configuration and CLAUDE.md |

### Design decisions

- **Dual-layer state**: Session ID lives both in memory (fast access) and SQLite (survives restarts). Both must be cleared.
- **Filesystem sentinel over SIGTERM**: Writing `_close` lets the container finish its current work and exit cleanly. No process killing.
- **Preserve message history**: Messages stay in SQLite so the next session can load recent context if the prompt is configured to do so.
- **Single-message guard**: `/clear` is only recognized when it's the only message in the batch. This prevents accidental clears when messages arrive simultaneously.
- **No error handling**: The clear path operations (in-memory delete, SQLite delete, file write) are simple and unlikely to fail. `closeStdin()` swallows errors silently since there may not be an active container.
