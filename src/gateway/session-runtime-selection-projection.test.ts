import { describe, expect, it } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { projectChatSessionMetadata } from "./server-methods/chat-metadata-session-projection.js";
import {
  buildGatewaySessionEventFields,
  buildGatewaySessionSnapshot,
} from "./session-event-payload.js";
import { projectSessionPatchResult } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const catalog = [
  { provider: "openai", id: "gpt-5.6-sol", name: "Sol", reasoning: true },
  { provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true },
];

describe("session runtime selection ownership projection", () => {
  it.each([
    { kind: "acp", key: "agent:main:main", locked: true },
    { kind: "native-lock", key: "agent:main:locked", locked: true },
    { kind: "runtime-pin", key: "agent:main:pinned", locked: false },
    { kind: "key-only", key: "agent:main:acp:no-owner", locked: false },
    { kind: "replaced-acp", key: "agent:main:replaced", locked: false },
  ])(
    "projects $kind from the authoritative row through all client surfaces",
    async ({ kind, key, locked }) => {
      await withOpenClawTestState(
        { scenario: "minimal", label: "runtime-selection-owner" },
        async (state) => {
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: "openai/gpt-5.6-sol",
                models: {
                  "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
                  "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
                },
              },
            },
          };
          let entry: SessionEntry = {
            sessionId: "current-session",
            lifecycleRevision: "current-revision",
            updatedAt: 1,
            ...(kind === "native-lock" ? { modelSelectionLocked: true } : {}),
            ...(kind === "runtime-pin" ? { agentRuntimeOverride: "codex" } : {}),
          };
          const scope = { agentId: "main", sessionKey: key, env: state.env };
          await upsertSessionEntryCore(scope, entry);
          if (kind === "acp" || kind === "replaced-acp") {
            await upsertAcpSessionMeta({
              cfg,
              agentId: "main",
              sessionKey: key,
              env: state.env,
              mutate: () => ({
                backend: "acpx",
                agent: "main",
                runtimeSessionName: key,
                mode: "persistent",
                state: "idle",
                lastActivityAt: 1,
              }),
            });
          }
          if (kind === "replaced-acp") {
            entry = { ...entry, lifecycleRevision: "replacement-revision" };
            await upsertSessionEntryCore(scope, entry);
          }
          const row = buildGatewaySessionRow({
            cfg,
            agentId: "main",
            key,
            entry,
            store: { [key]: entry },
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            modelCatalog: catalog,
            lightweightListRow: true,
            skipTranscriptUsageFallback: true,
          });
          expect(row.runtimeSelectionLocked).toBe(locked);
          expect(row.modelSelectionLocked).toBe(kind === "native-lock" ? true : undefined);
          if (kind === "runtime-pin") {
            expect(row.agentRuntime?.source).toBe("session-key");
          }
          const metadata = projectChatSessionMetadata(
            { agentId: "main", sessionKey: key, sessionEntry: entry },
            { models: [], swarmEnabled: false },
            cfg,
          );
          expect(metadata.runtimeSelectionLocked).toBe(locked);
          const patched = projectSessionPatchResult({
            cfg,
            canonicalKey: key,
            entry,
            targetAgentId: "main",
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            modelCatalog: catalog,
          });
          expect(patched.resolved?.runtimeSelectionLocked).toBe(locked);
          expect(buildGatewaySessionEventFields({ sessionRow: row }).runtimeSelectionLocked).toBe(
            locked,
          );
          const lifecycle = buildGatewaySessionSnapshot({
            sessionRow: row,
            includeSession: true,
            lifecycle: true,
          });
          expect(lifecycle).not.toHaveProperty("runtimeSelectionLocked");
          expect(lifecycle).not.toHaveProperty("session.runtimeSelectionLocked");
          if (kind === "acp") {
            const project = (patch: { model?: string; agentRuntime?: null }) =>
              projectSessionsPatchEntry({
                cfg,
                storeKey: key,
                agentId: "main",
                existingEntry: entry,
                isLabelInUse: () => false,
                patch: { key, ...patch },
                loadGatewayModelCatalogSnapshot: async () => ({
                  entries: catalog,
                  routeVariants: catalog,
                }),
              });
            expect(await project({ model: "openai/gpt-5.6-luna" })).toMatchObject({
              ok: true,
              entry: { modelOverride: "gpt-5.6-luna" },
            });
            expect(
              await project({ model: "openai/gpt-5.6-luna", agentRuntime: null }),
            ).toMatchObject({
              ok: false,
              error: { message: "Runtime selection is owned by this ACP session." },
            });
          }
        },
      );
    },
  );
});
