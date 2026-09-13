import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    agentCommandMock,
    beginSpeakerTurn,
    configureVoiceStateGateway,
    createClient,
    createRuntime,
    getSessionEntry,
    lastAgentCommandArgs,
    lastRealtimeBridgeParams,
    makeVoiceConfig,
    managerModule,
    resolveConfiguredRealtimeVoiceProviderMock,
  }) => {
    it.each([false, true])(
      "uses current admission after native delegation roster lookup (policy revoked: %s)",
      async (revokePolicy) => {
        resolveConfiguredRealtimeVoiceProviderMock.mockReturnValue({
          provider: {
            id: "openai",
          },
          capabilities: { supportsActivationNameGating: false, handlesAgentConsult: true },
          providerConfig: { model: "gpt-live-1", voice: "marin" },
        });
        const discordConfig = makeVoiceConfig(
          { mode: "agent-proxy", realtime: { provider: "openai" } },
          { groupPolicy: "open", allowFrom: ["333"] },
        );
        let cfg: OpenClawConfig = { channels: { discord: discordConfig } };
        const readPolicy = createDiscordLivePolicyReader({
          cfg,
          accountId: "default",
          token: "synthetic-token",
          readConfig: () => cfg,
          resolvedAllowlist: { guildEntries: undefined, allowFrom: ["333"] },
        });
        const client = createClient();
        const rosterLookup = createDeferred<void>();
        const releaseRoster = createDeferred<void>();
        client.fetchMember.mockImplementation(async (_guildId: string, userId: string) => {
          if (userId === "444") {
            rosterLookup.resolve();
            await releaseRoster.promise;
          }
          return {
            nickname: userId === "444" ? "Roster member" : "Current speaker",
            roles: [],
            user: { id: userId, username: userId },
          };
        });
        const manager = new managerModule.DiscordVoiceManager({
          readPolicy,
          client: client as never,
          cfg,
          discordConfig,
          accountId: "default",
          runtime: createRuntime(),
        });
        agentCommandMock.mockResolvedValue({
          payloads: [{ text: "Authorized delegation completed." }],
        });
        try {
          expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
            ok: true,
          });
          configureVoiceStateGateway(client, () => [
            { guild_id: "g1", channel_id: "1001", user_id: "444" },
          ]);
          beginSpeakerTurn(getSessionEntry(manager), {
            userId: "333",
            senderIsOwner: false,
            speakerLabel: "Previous label",
            extraSystemPrompt: "Previous turn context",
          }).close();
          const runner = lastRealtimeBridgeParams().runAgentConsult;
          expect(runner).toBeTypeOf("function");
          const delegation = runner!({
            prompt: "Check the current agenda",
            signal: new AbortController().signal,
          });
          const outcome = revokePolicy
            ? expect(delegation).rejects.toThrow("authorization changed")
            : expect(delegation).resolves.toEqual({ text: "Authorized delegation completed." });
          await rosterLookup.promise;
          expect(agentCommandMock).not.toHaveBeenCalled();
          if (revokePolicy) {
            cfg = { channels: { discord: { ...discordConfig, groupPolicy: "disabled" } } };
          }
          releaseRoster.resolve();
          await outcome;
          if (revokePolicy) {
            expect(agentCommandMock).not.toHaveBeenCalled();
          } else {
            expect(agentCommandMock).toHaveBeenCalledOnce();
            expect(lastAgentCommandArgs()).toMatchObject({
              senderIsOwner: false,
              extraSystemPrompt: expect.stringContaining(
                'user_id="444" display_name="Roster member"',
              ),
            });
            expect(lastAgentCommandArgs().extraSystemPrompt).not.toContain("Previous turn context");
          }
        } finally {
          releaseRoster.resolve();
          await manager.destroy();
        }
      },
    );
  },
);
