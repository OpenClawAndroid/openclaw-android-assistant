import { describe, expect, it, vi } from "vitest";
import { settlePluginInstallTransactions } from "./install-transaction.js";
import {
  createPluginUpdateTransactionState,
  finalizePluginUpdateSummary,
} from "./update-summary.js";

const repairPeerLinks = vi.hoisted(() => vi.fn());
vi.mock("./update-config.js", () => ({ repairOpenClawPeerLinksForNpmInstalls: repairPeerLinks }));

describe("plugin install transaction settlement", () => {
  it.each(["commit", "rollback"] as const)(
    "does not replay a successful %s through duplicate or later settlement",
    async (action) => {
      const transaction = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };

      await Promise.all([
        settlePluginInstallTransactions([transaction, transaction], action),
        settlePluginInstallTransactions([transaction], action),
      ]);
      await settlePluginInstallTransactions([transaction], "commit");
      await settlePluginInstallTransactions([transaction], "rollback");

      expect(transaction[action]).toHaveBeenCalledOnce();
      expect(transaction[action === "commit" ? "rollback" : "commit"]).not.toHaveBeenCalled();
    },
  );

  it("retains failed rollback for recovery without replaying settled siblings", async () => {
    const failure = new Error("backup restore failed");
    const settled = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
    const pending = {
      commit: vi.fn(async () => {}),
      rollback: vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(),
    };
    await expect(
      settlePluginInstallTransactions([pending, settled], "rollback"),
    ).rejects.toMatchObject({
      errors: [failure],
    });
    await settlePluginInstallTransactions([pending, settled], "rollback");
    expect(pending.rollback).toHaveBeenCalledTimes(2);
    expect(settled.rollback).toHaveBeenCalledOnce();
  });
});

describe("plugin update finalization", () => {
  it.each([false, true])(
    "preserves the peer-link failure when rollback fails: %s",
    async (rollbackFails) => {
      const root = new Error("Cannot repair OpenClaw peer link: target is not a directory");
      const cleanup = new Error("Cannot restore plugin backup");
      repairPeerLinks.mockRejectedValueOnce(root);
      const rollback = vi.fn(async () => {
        if (rollbackFails) {
          throw cleanup;
        }
      });
      const transactionState = createPluginUpdateTransactionState({});
      transactionState.transactions.push({ commit: vi.fn(), rollback });

      const failure: unknown = await finalizePluginUpdateSummary({
        config: {},
        changed: true,
        outcomes: [],
        ranNpmInstaller: true,
        logger: {},
        transactionState,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(root.message);
      if (rollbackFails) {
        expect(failure).toMatchObject({ cause: root, errors: [root, cleanup] });
      } else {
        expect(failure).toBe(root);
      }
      expect(rollback).toHaveBeenCalledOnce();
    },
  );
});
