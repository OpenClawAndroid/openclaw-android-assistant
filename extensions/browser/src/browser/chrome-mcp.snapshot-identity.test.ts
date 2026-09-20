import { describe, expect, it, vi } from "vitest";
import {
  clickChromeMcpElement,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  setChromeMcpSessionFactoryForTest,
  takeChromeMcpSnapshot,
  withChromeMcpDocument,
} from "./chrome-mcp.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import { createPageSession, installChromeMcpSessionTestHooks } from "./chrome-mcp.test-support.js";

describe("Chrome MCP snapshot identity and lifetime", () => {
  installChromeMcpSessionTestHooks();

  it.each(
    [
      {
        label: "different document roots",
        child: {
          id: "child-root",
          role: "RootWebArea",
          children: [{ id: "button", role: "button" }],
        },
      },
      {
        label: "colliding document roots",
        child: {
          id: "root",
          role: "RootWebArea",
          children: [{ id: "child-button", role: "button" }],
        },
      },
      { label: "an omitted document root", child: { id: "button", role: "button" } },
    ].flatMap((fixture) =>
      ["snapshot", "document"].map((operation) => ({
        label: fixture.label,
        child: fixture.child,
        operation,
      })),
    ),
  )("rejects ambiguous $operation refs across $label", async ({ child, operation }) => {
    let root: ChromeMcpSnapshotNode = {
      id: "root",
      role: "RootWebArea",
      children: [{ id: "button", role: "button", name: "Run" }],
    };
    const clicks: unknown[] = [];
    const session = createPageSession({
      pid: 141,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return { structuredContent: { snapshot: root } };
        }
        if (call.name === "click") {
          clicks.push(call.arguments?.uid);
          return { content: [] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const [tab] = await listChromeMcpTabs("chrome-live");
    const target = { profileName: "chrome-live", targetId: tab!.targetId };
    const initial = await takeChromeMcpSnapshot(target);
    const oldRef = initial.children![0]!.id!;
    root = {
      ...root,
      children: [...root.children!, { id: "frame", role: "Iframe", children: [child] }],
    };
    const inspect = vi.fn(async () => "must not run");
    await expect(
      operation === "snapshot"
        ? takeChromeMcpSnapshot(target)
        : withChromeMcpDocument(target, inspect),
    ).rejects.toThrow(/ambiguous element IDs.*managed browser profile/);
    expect(inspect).not.toHaveBeenCalled();
    expect(
      [...session.routing!.snapshotRefById.values()].filter(
        (ref) => ref.targetId === target.targetId,
      ),
    ).toEqual([]);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);
    expect(clicks).toEqual([]);
    await expect(evaluateChromeMcpScript({ ...target, fn: "() => null" })).resolves.toBeNull();
  });

  it("preserves repeated UID aliases inside one document", async () => {
    const session = createPageSession({
      pid: 141,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: (call) =>
        call.name === "take_snapshot"
          ? {
              structuredContent: {
                snapshot: {
                  id: "root",
                  role: "RootWebArea",
                  children: [
                    { id: "button", role: "button" },
                    { role: "group", children: [{ id: "button", role: "button" }] },
                  ],
                },
              },
            }
          : undefined,
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const [tab] = await listChromeMcpTabs("chrome-live");
    const snapshot = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: tab!.targetId,
    });
    expect(snapshot.children![0]!.id).toMatch(/^mcp-ref:/);
    expect(snapshot.children![0]!.id).toBe(snapshot.children![1]!.children![0]!.id);
  });

  it.each(
    ["snapshot", "document"].flatMap((operation) =>
      [false, true].map((fails) => ({ operation, fails })),
    ),
  )(
    "retires target refs before $operation refresh, including failure=$fails",
    async ({ operation, fails }) => {
      let refreshing = false;
      let oldRef = "";
      const refPresentAtDispatch: boolean[] = [];
      const clicks: unknown[] = [];
      const session = createPageSession({
        pid: 141,
        pages: [
          { id: 1, url: "https://a.example" },
          { id: 2, url: "https://b.example" },
        ],
        onTool: (call) => {
          const pageId = call.arguments?.pageId;
          if (call.name === "take_snapshot") {
            if (typeof pageId !== "number") {
              throw new Error("Snapshot requires a numeric pageId");
            }
            if (refreshing) {
              refPresentAtDispatch.push(session.routing!.snapshotRefById.has(oldRef));
              if (fails) {
                return {
                  isError: true,
                  content: [{ type: "text", text: "snapshot failed after refresh" }],
                };
              }
            }
            return {
              structuredContent: {
                snapshot: {
                  id: `root-${pageId}`,
                  role: "RootWebArea",
                  children: [{ id: `button-${pageId}`, role: "button", name: "Run" }],
                },
              },
            };
          }
          if (call.name === "click") {
            clicks.push([pageId, call.arguments?.uid]);
            return { content: [] };
          }
          return undefined;
        },
      });
      setChromeMcpSessionFactoryForTest(async () => session);
      const tabs = await listChromeMcpTabs("chrome-live");
      const target = { profileName: "chrome-live", targetId: tabs[0]!.targetId };
      const sibling = { profileName: "chrome-live", targetId: tabs[1]!.targetId };
      oldRef = (await takeChromeMcpSnapshot(target)).children![0]!.id!;
      const siblingRef = (await takeChromeMcpSnapshot(sibling)).children![0]!.id!;
      refreshing = true;
      const refresh =
        operation === "snapshot"
          ? takeChromeMcpSnapshot(target)
          : withChromeMcpDocument(target, async () => true);
      if (fails) {
        await expect(refresh).rejects.toThrow("snapshot failed after refresh");
      } else {
        await refresh;
      }
      expect(refPresentAtDispatch).toEqual([false]);
      await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(
        /Unknown ref/,
      );
      await clickChromeMcpElement({ ...sibling, uid: siblingRef });
      expect(clicks).toEqual([[2, "button-2"]]);
    },
  );
});
