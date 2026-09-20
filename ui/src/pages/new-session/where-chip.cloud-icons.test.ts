/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { readDraftCloudProfiles } from "./discovery.ts";
import { renderPicker } from "./where-chip.test-support.ts";

describe("Cloud backend picker presentation", () => {
  it.each([
    { id: "production", backend: "aws", brand: "aws", label: "AWS" },
    { id: "aws", backend: "azure", brand: "azure", label: "Azure" },
    { id: "production", backend: "google-cloud", brand: "gcp", label: "Google Cloud" },
  ])(
    "uses backend $backend for named profile $id in both trigger and filtered menu",
    ({ id, backend, brand, label }) => {
      const onSelect = vi.fn();
      const cloudProfiles = readDraftCloudProfiles([
        {
          id,
          providerId: "crabbox",
          providerDisplayId: backend,
          operatingSystems: [{ id: "linux", label: "Linux", default: true }],
          machines: [{ id: "standard", label: "Standard", default: true }],
        },
      ]);
      const container = renderPicker(
        true,
        undefined,
        { cloudProfiles, cloudProfileId: id },
        {
          environmentQuery: label,
          onSelectCloudProfile: onSelect,
        },
      );
      const trigger = container.querySelector("#new-session-where-trigger")!;
      const row = container.querySelector<HTMLButtonElement>('[data-value="cloud:' + id + '"]')!;
      for (const element of [trigger, row]) {
        expect(element.querySelector('[data-provider-icon="' + brand + '"]')).not.toBeNull();
        expect(element.getAttribute("aria-description")).toBe(`Cloud worker provider: ${label}`);
        expect(element.textContent).toContain("Linux");
        expect(element.textContent).toContain("Standard");
      }
      expect(trigger.getAttribute("aria-label")).toBe(`Where: ${id}, Linux · Standard`);
      expect(row.hasAttribute("aria-label")).toBe(false);
      expect(
        row.querySelector(".session-menu__text")?.textContent?.replace(/\s+/g, " ").trim(),
      ).toBe(`${id} Linux · Standard`);
      row.click();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(id);
      const disabled = renderPicker(
        true,
        undefined,
        { cloudProfiles, cloudProfileId: id },
        { cloudDisabledReason: "Unavailable" },
      );
      expect(
        disabled.querySelector(
          '[data-value="cloud:' + id + '"] [data-provider-icon="' + brand + '"]',
        ),
      ).not.toBeNull();
    },
  );
});
