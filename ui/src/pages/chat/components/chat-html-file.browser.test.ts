import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { readFileDraft, setFileDraft } from "./chat-sidebar-file-view.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "./chat-sidebar.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

type FileContent = Extract<SidebarContent, { kind: "file" }>;
type Panel = HTMLElement & {
  content: FileContent;
  fileNavigation: { line: number } | null;
  updateComplete: Promise<unknown>;
};
const source = "<!doctype html>\n<h1>Original HTML</h1>\n<input aria-label=note>";
const opened: FileContent[] = [];

function button(panel: Panel, name: string) {
  const found = [...panel.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error("Missing button: " + name);
  }
  return found;
}

async function mount(name = "page.html", retained?: string, mimeType?: string) {
  const file: FileContent = {
    kind: "file",
    name,
    path: name,
    mimeType,
    content: source,
    draftKey: crypto.randomUUID(),
    edit: { hash: "initial", save: vi.fn(), fetchLatest: vi.fn() },
  };
  opened.push(file);
  if (retained) {
    setFileDraft(file, { content: retained, expectedHash: "initial" });
  }
  const panel = document.createElement("openclaw-chat-detail-panel") as Panel;
  panel.style.cssText = "width:100%;height:600px";
  panel.content = file;
  document.body.append(panel);
  await panel.updateComplete;
  await customElements.whenDefined("openclaw-chat-html-preview");
  await expect.poll(() => panel.querySelector("openclaw-chat-html-preview")).not.toBeNull();
  const preview = panel.querySelector("openclaw-chat-html-preview")!;
  preview.embedSandboxMode = "strict";
  const request = vi.fn(async (_method: string, params: { html: string }) => ({
    html: params.html,
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: 8444,
  }));
  Reflect.set(preview, "context", {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
      subscribe: () => () => {},
    },
  });
  await expect.poll(() => panel.querySelector("iframe")).not.toBeNull();
  return { panel, file, request };
}

afterEach(() => {
  document.body.replaceChildren();
  for (const file of opened.splice(0)) {
    setFileDraft(file, null);
  }
});

describe.runIf(browserMode)("HTML file presentation", () => {
  it("renders normalized HTML MIME without a filename extension", async () => {
    const { panel } = await mount("report", undefined, "Text/HTML; charset=utf-8");
    expect(panel.querySelector("iframe")?.srcdoc).toBe(source);
    expect(panel.querySelector(".cm-editor")).toBeNull();
  });

  it("opens rendered HTML before loading CodeMirror, then retains editor and undo through draft preview", async () => {
    const { panel, file } = await mount();
    const originalFrame = panel.querySelector("iframe");
    expect(originalFrame?.srcdoc).toBe(source);
    expect(panel.querySelector(".cm-editor")).toBeNull();
    expect(panel.querySelector("h1")).toBeNull();
    await userEvent.click(button(panel, "Edit file"));
    await expect
      .poll(() => panel.querySelector('.cm-content[contenteditable="true"]'))
      .not.toBeNull();
    const editor = panel.querySelector(".cm-editor");
    const input = panel.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.fill(input, "<h1>Unsaved draft</h1>");
    expect(readFileDraft(file)?.content).toBe("<h1>Unsaved draft</h1>");
    await userEvent.click(button(panel, "Preview"));
    await expect.poll(() => panel.querySelector("iframe")?.srcdoc).toBe("<h1>Unsaved draft</h1>");
    expect(panel.querySelector(".cm-editor")).toBe(editor);
    expect(input.checkVisibility()).toBe(false);
    await userEvent.click(button(panel, "Source"));
    expect(panel.querySelector(".cm-editor")).toBe(editor);
    expect(input.textContent).toContain("Unsaved draft");
    expect(button(panel, "Save").disabled).toBe(false);
    await userEvent.click(input);
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.poll(() => input.textContent).not.toContain("Unsaved draft");
  });

  it("keeps independent iframe instances and modes while two file panels are hidden and revealed", async () => {
    const first = await mount("first.html");
    const frame = first.panel.querySelector("iframe");
    first.panel.hidden = true;
    const second = await mount("second.htm");
    const otherFrame = second.panel.querySelector("iframe");
    await userEvent.click(button(second.panel, "Source"));
    second.panel.hidden = true;
    first.panel.hidden = false;
    await first.panel.updateComplete;
    expect(first.panel.querySelector("iframe")).toBe(frame);
    expect(second.panel.querySelector("iframe")).toBe(otherFrame);
    expect(button(first.panel, "Source")).toBeDefined();
    expect(button(second.panel, "Preview")).toBeDefined();
    expect(first.request).toHaveBeenCalledOnce();
    expect(second.request).toHaveBeenCalledOnce();
    first.panel.fileNavigation = { line: 2 };
    await expect
      .poll(() => first.panel.querySelector(".file-view__line--target")?.getAttribute("data-line"))
      .toBe("2");
    expect(button(first.panel, "Preview")).toBeDefined();
  });

  it("previews a retained unsaved draft without initializing or discarding its editor", async () => {
    const { panel, file } = await mount("draft.html", "<h1>Retained draft</h1>");
    expect(panel.querySelector("iframe")?.srcdoc).toBe("<h1>Retained draft</h1>");
    expect(panel.querySelector(".cm-editor")).toBeNull();
    await userEvent.click(button(panel, "Source"));
    await expect
      .poll(() => panel.querySelector(".cm-content")?.textContent)
      .toBe("<h1>Retained draft</h1>");
    expect(readFileDraft(file)?.content).toBe("<h1>Retained draft</h1>");
    await userEvent.click(button(panel, "Discard"));
    await userEvent.click(button(panel, "Preview"));
    await expect.poll(() => panel.querySelector("iframe")?.srcdoc).toBe(source);
    expect(readFileDraft(file)).toBeUndefined();
  });
});
