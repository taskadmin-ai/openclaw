import { ComponentType, MessageFlags } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as discordClient from "../client.js";
import { resolveDiscordComponentEntryWithPersistence } from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import {
  buildDiscordComponentMessage,
  parseDiscordComponentCustomId,
  type DiscordComponentMessageSpec,
} from "../components.js";
import { serializePayload } from "../internal/payload.js";
import { registerBuiltDiscordComponentMessage } from "../send.components.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const cfg: OpenClawConfig = {
  channels: { discord: { token: "synthetic-token", groupPolicy: "open" } },
};
const sourceSession = "agent:source:discord:channel:789";
const card: DiscordComponentMessageSpec = {
  reusable: true,
  blocks: [
    { type: "text", text: "Task @everyone" },
    { type: "text", text: "No check-ins yet." },
    {
      type: "actions",
      buttons: [
        { label: "Complete", style: "success", allowedUsers: ["*"], callbackData: "demo:complete" },
      ],
    },
  ],
};
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearDiscordComponentEntriesForTest();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture(
  registration: {
    messageId?: string;
    accountId?: string;
    mixedRoutes?: boolean;
  } = {},
) {
  const built = buildDiscordComponentMessage({
    spec: card,
    sessionKey: sourceSession,
    agentId: "source",
    accountId: registration.accountId ?? "default",
  });
  await registerBuiltDiscordComponentMessage({
    buildResult: built,
    messageId: registration.messageId ?? "1001",
  });
  const sourceComponents = [...built.components];
  if (registration.mixedRoutes) {
    const other = buildDiscordComponentMessage({
      spec: card,
      sessionKey: "agent:other:discord:channel:789",
      agentId: "other",
      accountId: "default",
    });
    await registerBuiltDiscordComponentMessage({ buildResult: other, messageId: "1001" });
    sourceComponents.push(...other.components);
  }
  let stored = {
    id: "1001",
    channel_id: "789",
    ...serializePayload({ components: sourceComponents }),
  };
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method, path, body }) => {
      if (path === "/v10/channels/789") {
        return { id: "789", type: 0, guild_id: "333" };
      }
      if (method === "PATCH") {
        stored = { ...stored, ...JSON.parse(body) };
      }
      return stored;
    },
  });
  cleanup.push(loopback.close);
  const createClient = discordClient.createDiscordClient;
  vi.spyOn(discordClient, "createDiscordClient").mockImplementation((opts) =>
    createClient({ ...opts, rest: loopback.rest }),
  );
  vi.spyOn(discordClient, "resolveDiscordRest").mockReturnValue(loopback.rest);
  return { ...loopback, built, stored: () => stored };
}

function edit(
  components: unknown,
  config = cfg,
  progressSnapshot?: Parameters<typeof handleDiscordMessageAction>[0]["progressSnapshot"],
) {
  return handleDiscordMessageAction({
    action: "edit",
    params: { messageId: "1001", components },
    cfg: config,
    ...(progressSnapshot ? { progressSnapshot } : {}),
    toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:789" },
  });
}

describe("Discord card edits through the message action", () => {
  it("updates and retires a reusable card without losing callback routing or re-pinging", async () => {
    const test = await fixture();
    await edit({
      ...card,
      blocks: [
        { type: "text", text: "Task @everyone" },
        { type: "text", text: "Completed: Casey" },
        card.blocks?.[2],
      ],
    });
    const patch = test.requests.find((request) => request.method === "PATCH");
    expect(patch?.path).toBe("/v10/channels/789/messages/1001");
    const body = JSON.parse(patch!.body);
    expect(body).toMatchObject({ content: null, embeds: [], sticker_ids: [], poll: null });
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    const children = body.components[0].components;
    expect(children.slice(0, 2)).toEqual([
      { type: ComponentType.TextDisplay, content: "Task @everyone" },
      { type: ComponentType.TextDisplay, content: "Completed: Casey" },
    ]);
    const button = children[2].components[0];
    expect(button.label).toBe("Complete");
    const parsed = parseDiscordComponentCustomId(button.custom_id);
    expect(parsed).not.toBeNull();
    const entry = await resolveDiscordComponentEntryWithPersistence({
      id: parsed!.componentId,
      consume: false,
    });
    expect(entry).toMatchObject({
      messageId: "1001",
      accountId: "default",
      sessionKey: sourceSession,
      agentId: "source",
      callbackData: "demo:complete",
      reusable: true,
      allowedUsers: ["*"],
    });

    await edit({ blocks: [{ type: "text", text: "Task @everyone\nCompleted: Casey" }] });
    expect(test.stored().components).toEqual([
      {
        type: ComponentType.Container,
        components: [
          { type: ComponentType.TextDisplay, content: "Task @everyone\nCompleted: Casey" },
        ],
      },
    ]);
    expect(test.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("keeps message-action gates and component validation ahead of edits", async () => {
    const test = await fixture();
    await expect(
      edit(card, {
        channels: { discord: { ...cfg.channels?.discord, actions: { messages: false } } },
      }),
    ).rejects.toThrow("Discord message edits are disabled");
    await expect(edit({})).rejects.toThrow("structured component specification");
    expect(test.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it.each([
    { label: "message", registration: { messageId: "1002" } },
    { label: "account", registration: { accountId: "other" } },
  ])(
    "refuses a card whose callback registration belongs to another $label",
    async ({ registration }) => {
      const test = await fixture(registration);

      await expect(edit(card)).rejects.toThrow("registration does not match edit target");

      expect(
        test.requests.some((request) => request.path === "/v10/channels/789/messages/1001"),
      ).toBe(true);
      expect(test.requests.filter((request) => request.method === "PATCH")).toEqual([]);
    },
  );

  it("does not merge callback routes from different source sessions", async () => {
    const test = await fixture({ mixedRoutes: true });

    await expect(edit(card)).rejects.toThrow("cannot merge different callback routes");

    expect(test.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("rejects component edits combined with a progress snapshot before provider I/O", async () => {
    const test = await fixture();

    await expect(edit(card, cfg, { lines: ["Working"] })).rejects.toThrow(
      "component edits cannot include a progress snapshot",
    );

    expect(test.requests).toEqual([]);
  });

  it("denies a disallowed channel before reading or editing its card", async () => {
    const test = await fixture();

    await expect(
      edit(card, {
        channels: { discord: { ...cfg.channels?.discord, groupPolicy: "disabled" } },
      }),
    ).rejects.toThrow("Discord read target channel is not allowed");

    expect(test.requests.filter((request) => request.path?.includes("/messages/"))).toEqual([]);
    expect(test.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });
});
