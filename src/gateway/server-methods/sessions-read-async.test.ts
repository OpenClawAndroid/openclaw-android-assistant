import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as combinedStores from "../../config/sessions/combined-store-gateway.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as pageReads from "../../config/sessions/session-accessor.sqlite-list-read.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

function viewerConfig(others: "view" | "none"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "viewer",
        definitions: {
          viewer: {
            agents: "*",
            scopes: ["operator.read", "operator.write"],
            sessions: { others },
          },
        },
      },
    },
  };
}

it.each([
  "membership",
  "membership-unpublished",
  "membership-external",
  "visibility",
  "identity",
  "config",
] as const)(
  "rechecks current %s after the selected page has been read asynchronously",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const viewer = ensureProfileForEmail("page-viewer@example.test").id;
      const owner = ensureProfileForEmail("page-owner@example.test").id;
      const scope = { agentId: "main", sessionKey: "agent:main:selected-page" };
      const membershipChange = change.startsWith("membership");
      const replacementKey = "agent:main:replacement-page";
      const selected: SessionEntry = {
        sessionId: "selected-page",
        updatedAt: 300,
        visibility: change === "identity" ? "draft" : membershipChange ? "read-only" : "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: change === "identity" ? viewer : owner,
        },
      };
      replaceSessionEntrySync(scope, selected);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: replacementKey },
        {
          sessionId: "replacement-page",
          updatedAt: 200,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: change === "identity" ? owner : viewer,
          },
        },
      );
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:tail-page" },
        {
          sessionId: "tail-page",
          updatedAt: 100,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: change === "identity" ? owner : viewer,
          },
        },
      );
      if (membershipChange) {
        addSessionMember(scope, { identityId: viewer, addedBy: owner });
      }
      let config = viewerConfig("view");
      const context = requestContext(config);
      context.getRuntimeConfig = () => config;
      const client = identifiedClient(viewer);
      const inventory = vi.spyOn(combinedStores, "loadCombinedSessionStoreForGatewayAsync");
      const originalRead = pageReads.readSessionListPageReadOnlyAsync;
      const pageRead = vi.spyOn(pageReads, "readSessionListPageReadOnlyAsync");
      pageRead.mockImplementationOnce(async (...args) => {
        const page = await originalRead(...args);
        expect(page.entries).toMatchObject([
          {
            ok: true,
            value: {
              entries: [{ sessionKey: scope.sessionKey, entry: { sessionId: selected.sessionId } }],
              membershipKeys: membershipChange ? [scope.sessionKey] : [],
            },
          },
        ]);
        // Deliver the real prepared page only after authority has changed.
        if (change === "config") {
          config = viewerConfig("none");
        } else if (change === "identity") {
          client.authenticatedUserProfile = {
            ...client.authenticatedUserProfile!,
            profileId: owner,
          };
        } else {
          if (change === "membership-external") {
            const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
            try {
              external
                .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
                .run(scope.sessionKey, viewer);
            } finally {
              external.close();
            }
          } else if (membershipChange) {
            expect(removeSessionMember(scope, viewer)).not.toBeNull();
          } else {
            replaceSessionEntrySync(scope, {
              ...selected,
              visibility: "draft",
            });
          }
          if (change === "membership" || change === "visibility") {
            emitSessionsChanged(context, { reason: "sharing", sessionKey: scope.sessionKey });
          }
        }
        return page;
      });

      const result = await listSessions({
        client,
        context,
        request: { agentId: "main", limit: 1, includeActivitySummary: true },
      });
      expect(inventory).toHaveBeenCalledOnce();
      if (membershipChange) {
        expect(pageRead).toHaveBeenCalledOnce();
        expect(result.sessions).toMatchObject([
          { key: scope.sessionKey, sharingRole: "viewer", activitySummary: { canEnsure: false } },
        ]);
      } else {
        expect(pageRead).toHaveBeenCalledTimes(2);
        expect(result.sessions.map((session) => session.key)).toEqual([replacementKey]);
        expect(result).toMatchObject({ count: 1, nextOffset: 1 });
      }
    });
  },
);
