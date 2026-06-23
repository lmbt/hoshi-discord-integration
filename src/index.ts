import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type DMChannel,
  AttachmentBuilder,
  EmbedBuilder,
} from "discord.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename, dirname } from "node:path";

interface ActiveReply {
  userId: string;
  channelId: string;
}

export default function (pi: ExtensionAPI) {
  let client: Client | null = null;
  let connected = false;

  // Loaded from env
  let botToken = "";
  let allowedUserIds: string[] = [];
  let attachmentDir = "";
  let stripReasoning = true;
  let stripTools = true;

  // Track which Discord conversation triggered the current agent turn
  let activeReply: ActiveReply | null = null;

  // --- Helpers ---

  function isAllowed(userId: string): boolean {
    return allowedUserIds.includes(userId);
  }

  function loadEnv(): boolean {
    botToken = process.env.DISCORD_BOT_TOKEN ?? "";
    if (!botToken) return false;

    const idsRaw = process.env.DISCORD_ALLOWED_USER_IDS ?? "";
    allowedUserIds = idsRaw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (allowedUserIds.length === 0) return false;

    attachmentDir = process.env.DISCORD_ATTACHMENT_DIR ?? "";

    stripReasoning = (process.env.DISCORD_STRIP_REASONING ?? "true").toLowerCase() !== "false";
    stripTools = (process.env.DISCORD_STRIP_TOOLS ?? "true").toLowerCase() !== "false";

    return true;
  }

  async function ensureConnected(_cwd?: string): Promise<boolean> {
    if (connected && client) return true;

    if (!loadEnv()) return false;

    client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    client.on("messageCreate", (message: Message) => {
      if (message.author.bot) return;
      if (!message.channel.isDMBased()) return;
      if (!isAllowed(message.author.id)) return;

      // Track who we need to reply to
      activeReply = {
        userId: message.author.id,
        channelId: message.channel.id,
      };

      // Format the incoming message for the agent
      const attachmentInfo =
        message.attachments.size > 0
          ? `\n[Attachments: ${message.attachments.map((a) => `${a.name} (${a.url})`).join(", ")}]`
          : "";

      const prompt = `[Discord DM from ${message.author.tag} (user_id: ${message.author.id}, channel_id: ${message.channel.id}, message_id: ${message.id})]: ${message.content}${attachmentInfo}`;

      // Inject as a user message so the agent processes it immediately
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    });

    await client.login(botToken);
    connected = true;
    return true;
  }

  // --- Inject instructions when responding to Discord DMs ---

  pi.on("before_agent_start", async (event, ctx) => {
    if (!activeReply) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Discord DM Context\n" +
        "You are responding to a Discord DM. Your final text response will be sent automatically as a Discord message.\n" +
        "- Do NOT mention or narrate your own actions (e.g. 'I've attached...', 'I reacted with...', 'Here's the file I sent'). Just do them silently.\n" +
        "- If you send an attachment, embed, or reaction, do NOT reference it in your text reply. The user will see it directly.\n" +
        "- Do NOT claim to attach images or files unless you explicitly call discord_send_message or discord_send_embed with attachments.\n" +
        "- Do NOT use markdown image syntax — it won't render in Discord DMs.\n" +
        "- Keep responses concise — Discord has a 2000 character limit per message.\n",
    };
  });

  // --- Auto-reply: capture final assistant output and send to Discord ---

  pi.on("agent_end", async (event, ctx) => {
    if (!activeReply || !client || !connected) return;

    const reply = activeReply;
    activeReply = null;

    // Extract the final assistant text from the turn's messages.
    // We want ONLY clean text — no tool calls, no thinking blocks, no reasoning.
    const messages = event.messages ?? [];
    let finalText = "";

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      // msg.content can be a string or array of content blocks
      if (typeof msg.content === "string") {
        finalText = stripReasoning ? stripThinking(msg.content) : msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((block: any) => {
            if (block.type === "text") return true;
            if (!stripTools && block.type === "tool_use") return true;
            return false;
          })
          .map((block: any) => {
            if (block.type === "text") {
              return stripReasoning ? stripThinking(block.text) : block.text;
            }
            // tool_use block (only reached if stripTools is false)
            return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
          })
          .filter(Boolean)
          .join("\n");
        if (textParts) {
          finalText = textParts;
        }
      }
    }

    if (!finalText.trim()) return;

    // Send the reply back to Discord
    try {
      const channel = await client.channels.fetch(reply.channelId);
      if (channel && channel.isDMBased()) {
        const dmChannel = channel as DMChannel;

        // Discord has a 2000 char limit per message; split if needed
        const chunks = splitMessage(finalText, 2000);
        for (const chunk of chunks) {
          await dmChannel.send(chunk);
        }
      }
    } catch (err) {
      // Don't crash the extension if Discord send fails
      ctx.ui.setStatus("discord", `Discord: reply failed`);
    }
  });

  function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at a newline
      let splitIdx = remaining.lastIndexOf("\n", maxLen);
      if (splitIdx <= 0) splitIdx = maxLen;
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).replace(/^\n/, "");
    }
    return chunks;
  }

  function stripThinking(text: string): string {
    // Remove <think>...</think> blocks (including multiline)
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
    // Remove unclosed <think> tags (model started thinking but didn't close)
    cleaned = cleaned.replace(/<think>[\s\S]*/g, "");
    // Remove everything before </think> (reasoning without opening tag)
    cleaned = cleaned.replace(/^[\s\S]*?<\/think>\s*/g, "");
    return cleaned.trim();
  }

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await ensureConnected(ctx.cwd);
    if (loaded) {
      ctx.ui.setStatus("discord", "Discord: connected");
    }
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      client.destroy();
      client = null;
      connected = false;
    }
  });

  // --- Tools ---

  pi.registerTool({
    name: "discord_send_message",
    label: "Discord Send Message",
    description:
      "Send a DM to an allowed Discord user by their user ID. Can include text and/or file attachments.",
    promptSnippet: "Send a Discord DM to an allowed user",
    promptGuidelines: [
      "Use discord_send_message to send a Discord DM. The target user_id must be in the allowedUserIds list.",
    ],
    parameters: Type.Object({
      user_id: Type.String({ description: "Discord user ID to send the message to" }),
      content: Type.Optional(Type.String({ description: "Text content of the message" })),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Local file path to attach" }),
            name: Type.Optional(
              Type.String({ description: "Override filename for the attachment" })
            ),
          }),
          { description: "Files to attach to the message" }
        )
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!(await ensureConnected(ctx.cwd))) {
        throw new Error(
          "Discord not connected. Ensure DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS are set."
        );
      }

      if (!isAllowed(params.user_id)) {
        throw new Error(`User ${params.user_id} is not in the allowed user list.`);
      }

      if (!params.content && (!params.attachments || params.attachments.length === 0)) {
        throw new Error("Must provide either content or attachments (or both).");
      }

      const user = await client!.users.fetch(params.user_id);
      const dm = await user.createDM();

      const files: AttachmentBuilder[] = [];
      if (params.attachments) {
        for (const att of params.attachments) {
          const filePath = resolve(ctx.cwd, att.path);
          const data = await readFile(filePath);
          files.push(new AttachmentBuilder(data, { name: att.name ?? basename(filePath) }));
        }
      }

      const sent = await dm.send({
        content: params.content ?? undefined,
        files,
      });

      return {
        content: [{ type: "text", text: `Message sent to ${user.tag} (ID: ${sent.id})` }],
        details: { messageId: sent.id, channelId: dm.id },
      };
    },
  });

  pi.registerTool({
    name: "discord_react",
    label: "Discord React",
    description:
      "React to a Discord message with an emoji. Provide either a channel_id or user_id (to look up the DM channel).",
    promptSnippet: "React to a Discord DM message with an emoji",
    promptGuidelines: [
      "Use discord_react to add an emoji reaction to a specific Discord message by its ID. You can use the channel_id from the incoming message metadata, or just provide the user_id and the DM channel will be resolved automatically.",
    ],
    parameters: Type.Object({
      user_id: Type.Optional(
        Type.String({ description: "Discord user ID (used to resolve the DM channel if channel_id is not provided)" })
      ),
      channel_id: Type.Optional(
        Type.String({ description: "DM channel ID where the message is" })
      ),
      message_id: Type.String({ description: "Message ID to react to" }),
      emoji: Type.String({
        description: "Emoji to react with (unicode emoji like 👍 or custom emoji name)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!(await ensureConnected(ctx.cwd))) {
        throw new Error(
          "Discord not connected. Ensure DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS are set."
        );
      }

      if (!params.channel_id && !params.user_id) {
        throw new Error("Must provide either channel_id or user_id.");
      }

      let dmChannel: DMChannel;

      if (params.channel_id) {
        const channel = await client!.channels.fetch(params.channel_id);
        if (!channel || !channel.isDMBased()) {
          throw new Error(`Channel ${params.channel_id} is not a valid DM channel.`);
        }
        dmChannel = channel as DMChannel;
      } else {
        if (!isAllowed(params.user_id!)) {
          throw new Error(`User ${params.user_id} is not in the allowed user list.`);
        }
        const user = await client!.users.fetch(params.user_id!);
        dmChannel = await user.createDM();
      }

      const message = await dmChannel.messages.fetch(params.message_id);
      await message.react(params.emoji);

      return {
        content: [
          {
            type: "text",
            text: `Reacted with ${params.emoji} to message ${params.message_id}`,
          },
        ],
        details: { messageId: params.message_id, emoji: params.emoji },
      };
    },
  });

  pi.registerTool({
    name: "discord_download_attachment",
    label: "Discord Download Attachment",
    description: "Download an attachment from a Discord message to a local file path.",
    promptSnippet: "Download a Discord message attachment to a local file",
    promptGuidelines: [
      "Use discord_download_attachment to save a Discord file attachment to the local filesystem.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Attachment URL from a received message" }),
      save_path: Type.String({ description: "Local path to save the file to" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!(await ensureConnected(ctx.cwd))) {
        throw new Error(
          "Discord not connected. Ensure DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS are set."
        );
      }

      const baseDir = attachmentDir || ctx.cwd;
      const savePath = resolve(baseDir, params.save_path);
      await mkdir(dirname(savePath), { recursive: true });

      const response = await fetch(params.url);
      if (!response.ok) {
        throw new Error(
          `Failed to download attachment: ${response.status} ${response.statusText} (URL may have expired)`
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        throw new Error("Downloaded file is empty — the attachment URL may have expired.");
      }

      await writeFile(savePath, buffer);

      // Verify the file was actually written
      const { stat } = await import("node:fs/promises");
      const fileStat = await stat(savePath).catch(() => null);
      if (!fileStat || fileStat.size === 0) {
        throw new Error(`File write failed — expected ${buffer.length} bytes at ${savePath}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Downloaded attachment to ${savePath} (${buffer.length} bytes)`,
          },
        ],
        details: { path: savePath, size: buffer.length },
      };
    },
  });

  pi.registerTool({
    name: "discord_list_users",
    label: "Discord List Allowed Users",
    description: "List the allowed Discord users configured for this extension.",
    promptSnippet: "List allowed Discord users",
    promptGuidelines: [
      "Use discord_list_users to see which Discord users are in the allowlist.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!(await ensureConnected(ctx.cwd))) {
        throw new Error(
          "Discord not connected. Ensure DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS are set."
        );
      }

      const users: { id: string; tag: string; status: string }[] = [];
      for (const userId of allowedUserIds) {
        try {
          const user = await client!.users.fetch(userId);
          users.push({ id: user.id, tag: user.tag, status: "fetchable" });
        } catch {
          users.push({ id: userId, tag: "unknown", status: "not found" });
        }
      }

      const formatted = users.map((u) => `${u.tag} (${u.id}) - ${u.status}`).join("\n");

      return {
        content: [{ type: "text", text: formatted || "No allowed users configured." }],
        details: { users },
      };
    },
  });

  pi.registerTool({
    name: "discord_send_embed",
    label: "Discord Send Embed",
    description:
      "Send a rich embed message (with optional file attachments) to an allowed Discord user via DM. Supports title, description, color, fields, images, thumbnails, and footer.",
    promptSnippet: "Send a rich embed (with optional attachments) to a Discord user",
    promptGuidelines: [
      "Use discord_send_embed to send visually rich messages with structured fields, images, or formatted content to a Discord user.",
    ],
    parameters: Type.Object({
      user_id: Type.String({ description: "Discord user ID to send to" }),
      title: Type.Optional(Type.String({ description: "Embed title" })),
      description: Type.Optional(Type.String({ description: "Embed description/body text" })),
      url: Type.Optional(Type.String({ description: "URL the title links to" })),
      color: Type.Optional(
        Type.Number({ description: "Embed color as decimal integer (e.g. 0x00ff00 = 65280)" })
      ),
      fields: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Field name" }),
            value: Type.String({ description: "Field value" }),
            inline: Type.Optional(Type.Boolean({ description: "Display inline" })),
          }),
          { description: "Embed fields" }
        )
      ),
      thumbnail_url: Type.Optional(Type.String({ description: "Thumbnail image URL" })),
      image_url: Type.Optional(Type.String({ description: "Large image URL" })),
      footer: Type.Optional(Type.String({ description: "Footer text" })),
      content: Type.Optional(
        Type.String({ description: "Plain text content sent alongside the embed" })
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Local file path to attach" }),
            name: Type.Optional(Type.String({ description: "Override filename" })),
          }),
          { description: "File attachments to include with the message" }
        )
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!(await ensureConnected(ctx.cwd))) {
        throw new Error(
          "Discord not connected. Ensure DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS are set."
        );
      }

      if (!isAllowed(params.user_id)) {
        throw new Error(`User ${params.user_id} is not in the allowed user list.`);
      }

      const user = await client!.users.fetch(params.user_id);
      const dm = await user.createDM();

      const embed = new EmbedBuilder();
      if (params.title) embed.setTitle(params.title);
      if (params.description) embed.setDescription(params.description);
      if (params.url) embed.setURL(params.url);
      if (params.color !== undefined) embed.setColor(params.color);
      if (params.fields) {
        for (const field of params.fields) {
          embed.addFields({ name: field.name, value: field.value, inline: field.inline });
        }
      }
      if (params.thumbnail_url) embed.setThumbnail(params.thumbnail_url);
      if (params.image_url) embed.setImage(params.image_url);
      if (params.footer) embed.setFooter({ text: params.footer });

      const files: AttachmentBuilder[] = [];
      if (params.attachments) {
        for (const att of params.attachments) {
          const filePath = resolve(ctx.cwd, att.path);
          const data = await readFile(filePath);
          files.push(new AttachmentBuilder(data, { name: att.name ?? basename(filePath) }));
        }
      }

      const sent = await dm.send({
        content: params.content ?? undefined,
        embeds: [embed],
        files,
      });

      return {
        content: [
          { type: "text", text: `Embed sent to ${user.tag} (ID: ${sent.id})` },
        ],
        details: { messageId: sent.id, channelId: dm.id },
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("discord", {
    description: "Show Discord connection status",
    handler: async (_args, ctx) => {
      if (!connected) {
        ctx.ui.notify("Discord: not connected", "warning");
        return;
      }
      ctx.ui.notify("Discord: connected and listening for DMs", "info");
    },
  });

  pi.registerCommand("discord-connect", {
    description: "Connect or reconnect to Discord",
    handler: async (_args, ctx) => {
      if (client) {
        client.destroy();
        client = null;
        connected = false;
      }
      const ok = await ensureConnected(ctx.cwd);
      if (ok) {
        ctx.ui.notify("Discord: connected successfully", "info");
      } else {
        ctx.ui.notify(
          "Discord: failed to connect. Check DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS env vars.",
          "error"
        );
      }
    },
  });
}
