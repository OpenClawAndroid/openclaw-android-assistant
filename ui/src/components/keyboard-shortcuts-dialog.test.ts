/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./keyboard-shortcuts-dialog.ts";

type KeyboardShortcutsTestDialog = HTMLElement & {
  isOpen: boolean;
  sendShortcut: "enter" | "modifier-enter";
  toggle(): void;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("keyboard shortcuts dialog", () => {
  it.each([
    { platform: "Win32", modifier: "Ctrl", shift: "Shift", alt: "Alt", enter: "Enter" },
    { platform: "MacIntel", modifier: "⌘", shift: "⇧", alt: "⌥", enter: "⏎" },
  ])(
    "renders grouped shortcut chips and send preferences on $platform",
    async ({ platform, modifier, shift, alt, enter }) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const dialog = document.body.appendChild(
        document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
      );
      dialog.toggle();
      await dialog.updateComplete;

      expect(dialog.shadowRoot?.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
      expect(
        Array.from(
          dialog.shadowRoot?.querySelectorAll("h3") ?? [],
          (heading) => heading.textContent,
        ),
      ).toEqual(["General", "Chat", "Panels", "Sidebar", "Image viewer", "Approvals"]);
      for (const [label, key] of [
        ["Open New Session", "O"],
        ["Archive current session", "A"],
      ] as const) {
        const row = Array.from(dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? []).find(
          (candidate) => candidate.textContent?.includes(label),
        );
        expect(Array.from(row?.querySelectorAll("kbd") ?? [], (kbd) => kbd.textContent)).toEqual([
          modifier,
          shift,
          key,
        ]);
      }
      const selectionRow = Array.from(
        dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? [],
      ).find((row) => row.textContent?.includes("Select multiple sessions"));
      expect(
        Array.from(selectionRow?.querySelectorAll("kbd") ?? [], (key) => key.textContent),
      ).toEqual([alt, "Click"]);

      const sendRow = () =>
        Array.from(dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? []).find((row) =>
          row.textContent?.includes("Send message"),
        );
      expect(
        Array.from(sendRow()?.querySelectorAll("kbd") ?? [], (key) => key.textContent),
      ).toEqual([enter]);

      dialog.sendShortcut = "modifier-enter";
      await dialog.updateComplete;

      expect(
        Array.from(sendRow()?.querySelectorAll("kbd") ?? [], (key) => key.textContent),
      ).toEqual([modifier, enter]);
      dialog.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
      await dialog.updateComplete;
      expect(dialog.isOpen).toBe(false);
      expect(dialog.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it("closes when the modal dispatches its Escape cancellation", async () => {
    const dialog = document.body.appendChild(
      document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
    );
    dialog.toggle();
    await dialog.updateComplete;

    dialog.shadowRoot
      ?.querySelector("openclaw-modal-dialog")
      ?.dispatchEvent(new CustomEvent("modal-cancel"));
    await dialog.updateComplete;

    expect(dialog.isOpen).toBe(false);
  });
});
