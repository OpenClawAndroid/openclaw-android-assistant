import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { isOpen: true, close: vi.fn<() => void>() };
  return {
    db,
    identity: vi.fn<(location: string, expected: string) => void>(),
    openTracked: vi.fn(() => db),
    openPrivate: vi.fn(() => db),
    closeHandle: vi.fn<(owner: { db: typeof db; afterClose: () => void }) => unknown[]>(),
  };
});

vi.mock("../infra/sqlite-worker-identity.js", () => ({
  assertExistingDatabaseIdentity: mocks.identity,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.openPrivate,
}));
vi.mock("./openclaw-state-db-handle.js", () => ({
  openTrackedStateDatabase: mocks.openTracked,
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  openClawStateDatabaseCache: { closeOpenClawStateDatabaseHandle: mocks.closeHandle },
}));

import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";

const pathname = "/fixture/state.sqlite";
const expectedIdentity = "file:1:2";

beforeEach(() => {
  mocks.identity.mockReset();
  mocks.openTracked.mockClear();
  mocks.openPrivate.mockClear();
  mocks.db.isOpen = true;
  mocks.db.close.mockReset().mockImplementation(() => {
    mocks.db.isOpen = false;
  });
  mocks.closeHandle.mockReset().mockImplementation((owner) => {
    try {
      owner.db.close();
      owner.afterClose();
      return [];
    } catch (error) {
      return [error];
    }
  });
});

it("refuses a changed physical identity before opening a native reader", () => {
  const primary = new Error("SQLite file identity changed");
  mocks.identity.mockImplementation(() => {
    throw primary;
  });

  expect(() => openOpenClawStateReadConnection(pathname, pathname, expectedIdentity)).toThrow(
    primary,
  );
  expect(mocks.identity).toHaveBeenCalledWith(pathname, expectedIdentity);
  expect(mocks.openTracked).not.toHaveBeenCalled();
  expect(mocks.openPrivate).not.toHaveBeenCalled();
  expect(mocks.closeHandle).not.toHaveBeenCalled();
});

it("closes the opened reader before reporting a post-open identity change", () => {
  const primary = new Error("SQLite file identity changed after open");
  mocks.identity
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw primary;
    });

  expect(() => openOpenClawStateReadConnection(pathname, pathname, expectedIdentity)).toThrow(
    primary,
  );
  expect(mocks.openTracked).toHaveBeenCalledOnce();
  expect(mocks.closeHandle).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ db: mocks.db, path: pathname }),
  );
  expect(mocks.db.close).toHaveBeenCalledOnce();
  expect(mocks.db.isOpen).toBe(false);
});

it("preserves identity and close failures from a still-open native reader", () => {
  const primary = new Error("SQLite file identity changed after open");
  const cleanup = new Error("native reader close failed");
  mocks.identity
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw primary;
    });
  mocks.db.close.mockImplementation(() => {
    throw cleanup;
  });

  let failure: unknown;
  try {
    openOpenClawStateReadConnection(pathname, pathname, expectedIdentity);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
  expect(mocks.identity).toHaveBeenCalledWith(pathname, expectedIdentity);
  expect(mocks.openTracked).toHaveBeenCalledOnce();
  expect(mocks.closeHandle).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ db: mocks.db, path: pathname }),
  );
  expect(mocks.db.isOpen).toBe(true);
});
