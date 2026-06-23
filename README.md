# hoshi-discord-integration

A [pi-coding-agent](https://github.com/earendil-works/pi) extension for Discord DM integration. Allows pi to listen for DMs, send DMs, react to messages, and handle file attachments — restricted to an allowlist of user IDs.

## Setup

1. Install the package:

```bash
# From git (once published)
pi install git:github.com/YOUR_USER/hoshi-discord-integration

# Or from a local path during development
pi install ./path/to/hoshi-discord-integration

# Or try without installing
pi -e git:github.com/YOUR_USER/hoshi-discord-integration
```

2. Create a Discord bot at https://discord.com/developers/applications with these settings:
   - Enable **Message Content Intent** under Bot settings
   - The bot needs no server/guild — it only uses DMs

3. Set environment variables (in your shell profile, `.env`, or however pi loads env):

```bash
# Required
export DISCORD_BOT_TOKEN="your-bot-token-here"
export DISCORD_ALLOWED_USER_IDS="123456789012345678,987654321098765432"

# Optional: directory for downloaded attachments (defaults to cwd)
export DISCORD_ATTACHMENT_DIR="/home/user/discord-attachments"

# Optional: control what gets stripped from Discord replies (default: true)
export DISCORD_STRIP_REASONING="true"
export DISCORD_STRIP_TOOLS="true"
```

- `DISCORD_BOT_TOKEN` — your bot's token from the Discord developer portal
- `DISCORD_ALLOWED_USER_IDS` — comma-separated list of Discord user IDs that can interact with the bot
- `DISCORD_ATTACHMENT_DIR` — base directory for saving downloaded attachments (optional, defaults to project cwd)
- `DISCORD_STRIP_REASONING` — strip `<think>` blocks and reasoning from replies (default: `true`)
- `DISCORD_STRIP_TOOLS` — strip tool call output from replies (default: `true`)

## Tools

| Tool | Description |
|------|-------------|
| `discord_send_message` | Send a DM with text and/or file attachments |
| `discord_send_embed` | Send a rich embed (with optional attachments) — supports title, fields, images, color, footer |
| `discord_react` | React to a message with an emoji |
| `discord_unreact` | Remove the bot's reaction from a message |
| `discord_download_attachment` | Download a received attachment to a local file |
| `discord_message_history` | Fetch recent DM history with a user (supports pagination) |
| `discord_list_users` | List allowed users and their status |

## Commands

| Command | Description |
|---------|-------------|
| `/discord` | Show connection status |
| `/discord-connect` | Connect or reconnect to Discord |

## Security

- Only messages from users in `allowedUserIds` are processed
- Only DMs to/from allowed users can be sent
- The bot token is never exposed in tool outputs
- Attachments are downloaded to local paths you control

## How It Works

The extension connects to Discord on session start and listens for DMs from allowed users. When a DM arrives:

1. The bot shows a **typing indicator** in the DM channel
2. The message is injected into the agent as a user prompt (via `sendUserMessage`)
3. The agent processes it, potentially using tools, thinking, etc.
4. On `agent_end`, the extension extracts **only the final assistant text** (no tool output, no thinking) and sends it back to the Discord DM automatically
5. The typing indicator stops

The Discord user sees only the clean final reply. All intermediate tool calls, reasoning, and internal state stay in pi.

**Auto-reconnect:** If the Discord connection drops, the extension automatically attempts to reconnect after 5 seconds.

**Message history:** The agent can fetch earlier DM messages via `discord_message_history` for conversation context beyond what's in the current pi session.
