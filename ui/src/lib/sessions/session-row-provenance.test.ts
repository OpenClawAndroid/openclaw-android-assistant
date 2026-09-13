// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

describe("session row provenance", () => {
  it("retains fallback ownership when a self-projection materializes an unobserved row", () => {
    const provenance = createSessionRowProvenance();
    const row: GatewaySessionRow = { key: "global", sessionId: "session", kind: "global" };
    const donor = { ...row };
    provenance.observeReadRow(donor, 2, "home");

    expect(provenance.rowRevision(row)).toBe(0);
    expect(provenance.hasObservation(row)).toBe(false);
    expect(provenance.hasNewerFacts(row, -1)).toBe(true);
    expect(provenance.hasNewerFacts(row, 0)).toBe(false);
    expect(provenance.mergeRow(row, row, "work")).toBe(row);
    provenance.inheritRow(row, donor);
    expect(provenance.owner(row)).toBe("work");
    expect(provenance.hasObservation(row)).toBe(false);

    provenance.reset();
    expect(provenance.owner(row)).toBeNull();
    provenance.mergeRow(row, row, "new-owner");
    expect(provenance.owner(row)).toBe("new-owner");
  });

  it("preserves read and event field receipts across self-projection and retires them on reset", () => {
    const provenance = createSessionRowProvenance();
    const row: GatewaySessionRow = {
      key: "global",
      sessionId: "session",
      kind: "global",
      updatedAt: 1,
      label: "initial",
    };
    const readFields = provenance.observeReadRow(row, 1, "work");
    row.label = "updated";
    const eventFields = provenance.observeEvent(row, ["label"], 2, 2, "work");
    delete row.updatedAt;

    expect(provenance.mergeRow(row, row, "other")).toBe(row);
    expect(provenance.owner(row)).toBe("work");
    expect(readFields(row, ["label", "updatedAt"])).toEqual(["updatedAt"]);
    expect(eventFields(row, ["label", "updatedAt"])).toEqual(["label"]);
    expect(provenance.rowRevision(row)).toBe(1);
    expect(provenance.hasObservation(row)).toBe(true);
    expect(provenance.hasNewerFacts(row, 1)).toBe(true);
    expect(provenance.hasNewerFacts(row, 2)).toBe(false);

    provenance.reset();
    expect(readFields(row, ["updatedAt"])).toEqual([]);
    expect(eventFields(row, ["label"])).toEqual([]);
    expect(provenance.rowRevision(row)).toBe(0);
    expect(provenance.hasObservation(row)).toBe(false);
  });
});
