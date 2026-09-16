import { isDeepStrictEqual } from "node:util";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  LegacyMainSessionMigrationMode,
  LegacyMainSessionMigrationOutcome,
  PhysicalStore,
  SessionClaim,
} from "./legacy-main-session-migration.contract.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import {
  runSqliteSessionDeletionTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { readSessionTranscriptDigest } from "./session-accessor.sqlite-transcript-digest.js";
import type { SessionEntry } from "./types.js";

function projectEntryIdentity(entry: SessionEntry): SessionEntry {
  const projected = structuredClone(entry) as SessionEntry & {
    sessionFile?: unknown;
    transcriptPath?: unknown;
  };
  delete projected.sessionFile;
  delete projected.transcriptPath;
  return projected;
}

export function claimsMatch(left: SessionClaim, right: SessionClaim): boolean {
  return (
    isDeepStrictEqual(projectEntryIdentity(left.entry), projectEntryIdentity(right.entry)) &&
    left.digest.eventCount === right.digest.eventCount &&
    left.digest.rollingHash === right.digest.rollingHash
  );
}

export function readClaim(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  store: PhysicalStore,
  key: string,
  canonicalKey: string,
  append?: (row: { createdAt: number; eventJson: string }) => void,
): SessionClaim | undefined {
  const row = readExactSessionEntryRowForCanonicalRepair(database, key);
  if (!row) {
    return undefined;
  }
  return {
    canonicalKey,
    digest: readSessionTranscriptDigest(database, row.entry.sessionId, append),
    entry: row.entry,
    key,
    store,
  };
}

export function samePhysicalStore(left: PhysicalStore, right: PhysicalStore): boolean {
  return isSameOpenClawAgentDatabasePath(left.path, right.path);
}

function freshestClaim(claims: readonly SessionClaim[]): SessionClaim {
  return [...claims].toSorted((left, right) => {
    const freshness = (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0);
    return (
      freshness ||
      left.key.localeCompare(right.key) ||
      left.store.path.localeCompare(right.store.path)
    );
  })[0]!;
}

export function warningForDivergence(
  kind: "divergent-aliases" | "divergent-canonical",
  canonicalKey: string,
  claims: readonly SessionClaim[],
): string {
  const claimsText = claims.map((claim) => `${claim.store.path}#${claim.key}`).join(", ");
  return `session: ${kind} for ${canonicalKey}; preserved claims ${claimsText}. Run openclaw doctor --fix to quarantine the losing claims.`;
}

function writeMigratedSessionClaim(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  writeSessionEntry(database, sessionKey, entry, {
    allowStoredAliases: true,
    previousEntry: null,
  });
  replaceSessionOwnerInTransaction(database, sessionKey, entry.owner);
}

function mutateLegacySessionClaims<T>(
  params: {
    store: PhysicalStore;
    env: NodeJS.ProcessEnv;
    claims: readonly SessionClaim[];
    operationLabel:
      | "session-migration.legacy-main-in-place"
      | "session-migration.legacy-main-quarantine";
    beforePersistentApply?: () => void;
  },
  commit: (database: OpenClawAgentDatabase) => T,
): Promise<T> {
  const scope = {
    agentId: params.store.databaseAgentId,
    env: params.env,
    path: params.store.path,
    ownerStorePath: params.store.ownerStorePath,
  };
  return withSqliteSessionDeletions(
    scope,
    params.claims.map(({ key: sessionKey, entry }) => ({ sessionKey, entry })),
    async (assertCurrent) =>
      runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          assertCurrent();
          params.beforePersistentApply?.();
          return runSqliteSessionDeletionTransaction(commit, scope, {
            operationLabel: params.operationLabel,
          });
        },
        params.operationLabel,
      ),
  );
}

function migrateClaimsInPlace(params: {
  beforePersistentApply?: () => void;
  aliases: readonly SessionClaim[];
  canonical?: SessionClaim;
  canonicalKey: string;
  env: NodeJS.ProcessEnv;
  store: PhysicalStore;
  winner: SessionClaim;
}): Promise<boolean> {
  return mutateLegacySessionClaims(
    {
      ...params,
      claims: params.aliases.filter((claim) => claim.key !== params.canonicalKey),
      operationLabel: "session-migration.legacy-main-in-place",
    },
    (database) => {
      const currentAliases = params.aliases.map((claim) =>
        readClaim(database, params.store, claim.key, params.canonicalKey),
      );
      // Absence is part of the snapshot: owner preparation may let a new canonical row appear.
      const currentCanonical = readClaim(
        database,
        params.store,
        params.canonicalKey,
        params.canonicalKey,
      );
      if (
        currentAliases.some(
          (claim, index) => !claim || !claimsMatch(claim, params.aliases[index]!),
        ) ||
        (params.canonical
          ? !currentCanonical || !claimsMatch(currentCanonical, params.canonical)
          : currentCanonical !== undefined)
      ) {
        return false;
      }
      if (!currentCanonical) {
        writeMigratedSessionClaim(database, params.canonicalKey, params.winner.entry);
      }
      deleteLegacySessionEntryRows(
        database,
        params.aliases.map((claim) => claim.key),
        params.canonicalKey,
        {
          rehomeMembers: true,
          validatedEntries: new Map(currentAliases.map((claim) => [claim!.key, claim!.entry])),
        },
      );
      return true;
    },
  );
}

async function copyClaimCrossStore(params: {
  beforePersistentApply?: () => void;
  canonicalKey: string;
  destination: PhysicalStore;
  env: NodeJS.ProcessEnv;
  source: SessionClaim;
}): Promise<SessionClaim | undefined> {
  const sourceChanged = new Error("legacy session source changed before import");
  try {
    await importSqliteSessionRows({
      beforePersistentApply: params.beforePersistentApply,
      agentId: params.destination.databaseAgentId,
      defaultAgentId: params.destination.databaseAgentId,
      env: params.env,
      storePath: params.destination.path,
      sessionKey: params.canonicalKey,
      entry: params.source.entry,
      skipIfExists: true,
      readExactTranscriptRows: (append) => {
        const source = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readClaim(
              database,
              params.source.store,
              params.source.key,
              params.canonicalKey,
              append,
            ),
          {
            agentId: params.source.store.databaseAgentId,
            env: params.env,
            path: params.source.store.path,
          },
        );
        if (!source.found || !source.value || !claimsMatch(source.value, params.source)) {
          throw sourceChanged;
        }
      },
    });
  } catch (error) {
    if (error === sourceChanged) {
      return undefined;
    }
    throw error;
  }
  const destination = withOpenClawAgentDatabaseReadOnly(
    (database) => readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
    {
      agentId: params.destination.databaseAgentId,
      env: params.env,
      path: params.destination.path,
    },
  );
  return destination.found ? destination.value : undefined;
}

async function deleteExpectedClaim(
  claim: SessionClaim,
  commitGuard?: () => void,
): Promise<boolean> {
  const result = await deleteSessionEntryLifecycle({
    commitGuard,
    agentId: claim.store.databaseAgentId,
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
    expectedEntry: claim.entry,
    expectedTranscript: {
      sessionId: claim.entry.sessionId,
      digest: claim.digest,
    },
    requireWriteSuccess: true,
    storePath: claim.store.ownerStorePath,
    target: { canonicalKey: claim.key, storeKeys: [claim.key] },
  });
  return result.deleted;
}

function quarantineClaim(params: {
  beforePersistentApply?: () => void;
  claim: SessionClaim;
  env: NodeJS.ProcessEnv;
  ownerAgentId: string;
}): Promise<string | undefined> {
  return mutateLegacySessionClaims(
    {
      beforePersistentApply: params.beforePersistentApply,
      store: params.claim.store,
      env: params.env,
      claims: [params.claim],
      operationLabel: "session-migration.legacy-main-quarantine",
    },
    (database) => {
      const fresh = readClaim(
        database,
        params.claim.store,
        params.claim.key,
        params.claim.canonicalKey,
      );
      if (!fresh || !claimsMatch(fresh, params.claim)) {
        return undefined;
      }
      let quarantineKey: string;
      for (let index = 1; ; index += 1) {
        const candidate = `agent:${params.ownerAgentId}:legacy-main-conflict-${index}`;
        if (!readExactSessionEntryRow(database, candidate)) {
          quarantineKey = candidate;
          break;
        }
      }
      writeMigratedSessionClaim(database, quarantineKey, params.claim.entry);
      deleteLegacySessionEntryRows(database, [params.claim.key], quarantineKey, {
        rehomeMembers: true,
        validatedEntries: new Map([[fresh.key, fresh.entry]]),
      });
      return quarantineKey;
    },
  );
}

export async function processIdenticalClaims(params: {
  beforePersistentApply?: () => void;
  aliases: SessionClaim[];
  canonical?: SessionClaim;
  canonicalKey: string;
  destination: PhysicalStore;
  env: NodeJS.ProcessEnv;
  mode: LegacyMainSessionMigrationMode;
}): Promise<LegacyMainSessionMigrationOutcome> {
  const winner = params.canonical ?? freshestClaim(params.aliases);
  const crossStore = params.aliases.some(
    (claim) => !samePhysicalStore(claim.store, params.destination),
  );
  if (params.mode === "detect") {
    return {
      kind: params.canonical
        ? "canonical-exists-identical"
        : crossStore
          ? "migrated-cross-store"
          : "migrated-in-place",
      canonicalKey: params.canonicalKey,
      paths: [...new Set(params.aliases.map((claim) => claim.store.path))],
      sourceKeys: params.aliases.map((claim) => claim.key),
    };
  }

  let canonical = params.canonical;
  const destinationAliases = params.aliases.filter((claim) =>
    samePhysicalStore(claim.store, params.destination),
  );
  if (!canonical && destinationAliases.length > 0) {
    const inPlaceWinner = freshestClaim(destinationAliases);
    if (
      !(await migrateClaimsInPlace({
        beforePersistentApply: params.beforePersistentApply,
        aliases: destinationAliases,
        canonicalKey: params.canonicalKey,
        env: params.env,
        store: params.destination,
        winner: inPlaceWinner,
      }))
    ) {
      return {
        kind: "divergent-aliases",
        canonicalKey: params.canonicalKey,
        detail: "source aliases changed during the in-place transaction",
      };
    }
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
      {
        agentId: params.destination.databaseAgentId,
        env: params.env,
        path: params.destination.path,
      },
    );
    canonical = result.found ? result.value : undefined;
  }
  if (!canonical) {
    const sourceBefore = winner;
    const copied = await copyClaimCrossStore({
      beforePersistentApply: params.beforePersistentApply,
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      env: params.env,
      source: sourceBefore,
    });
    const sourceAfter = withOpenClawAgentDatabaseReadOnly(
      (database) => readClaim(database, sourceBefore.store, sourceBefore.key, params.canonicalKey),
      {
        agentId: sourceBefore.store.databaseAgentId,
        env: params.env,
        path: sourceBefore.store.path,
      },
    );
    if (
      !copied ||
      !claimsMatch(copied, sourceBefore) ||
      !sourceAfter.found ||
      !sourceAfter.value ||
      !claimsMatch(sourceAfter.value, sourceBefore)
    ) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: "source or imported canonical changed during cross-store copy verification",
      };
    }
    canonical = copied;
  }
  if (!claimsMatch(canonical, winner)) {
    return {
      kind: "divergent-canonical",
      canonicalKey: params.canonicalKey,
      detail: "canonical content differs from the legacy claim",
    };
  }

  // The destination commit is durable before source cleanup. Every retry therefore sees either
  // the original claim, an identical canonical claim, or both; no read-through fallback is needed.
  for (const claim of params.aliases) {
    if (samePhysicalStore(claim.store, params.destination)) {
      continue;
    }
    if (!(await deleteExpectedClaim(claim, params.beforePersistentApply))) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: `source changed before expected-entry cleanup: ${claim.store.path}#${claim.key}`,
      };
    }
  }
  if (params.canonical && destinationAliases.length > 0) {
    if (
      !(await migrateClaimsInPlace({
        beforePersistentApply: params.beforePersistentApply,
        aliases: destinationAliases,
        canonical: params.canonical,
        canonicalKey: params.canonicalKey,
        env: params.env,
        store: params.destination,
        winner: params.canonical,
      }))
    ) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: "canonical or aliases changed during in-place cleanup",
      };
    }
  }
  return {
    kind: params.canonical
      ? "canonical-exists-identical"
      : crossStore
        ? "migrated-cross-store"
        : "migrated-in-place",
    canonicalKey: params.canonicalKey,
    paths: [...new Set(params.aliases.map((claim) => claim.store.path))],
    sourceKeys: params.aliases.map((claim) => claim.key),
  };
}

export async function repairDivergentClaims(params: {
  beforePersistentApply?: () => void;
  canonicalKey: string;
  claims: SessionClaim[];
  destination: PhysicalStore;
  destinationCanonical?: SessionClaim;
  env: NodeJS.ProcessEnv;
  ownerAgentId: string;
}): Promise<{ quarantinedKeys: string[]; resolved: boolean }> {
  const winner = params.destinationCanonical ?? freshestClaim(params.claims);
  if (!params.destinationCanonical) {
    const migrated = await processIdenticalClaims({
      beforePersistentApply: params.beforePersistentApply,
      aliases: [winner],
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      env: params.env,
      mode: "automatic",
    });
    if (migrated.kind === "divergent-aliases" || migrated.kind === "divergent-canonical") {
      return { quarantinedKeys: [], resolved: false };
    }
  }
  const canonicalResult = withOpenClawAgentDatabaseReadOnly(
    (database) => readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
    {
      agentId: params.destination.databaseAgentId,
      env: params.env,
      path: params.destination.path,
    },
  );
  const canonical = canonicalResult.found ? canonicalResult.value : undefined;
  if (!canonical || !claimsMatch(canonical, winner)) {
    return { quarantinedKeys: [], resolved: false };
  }

  const quarantinedKeys: string[] = [];
  for (const claim of params.claims) {
    if (claim === winner || claim === params.destinationCanonical) {
      continue;
    }
    if (claimsMatch(claim, canonical)) {
      const cleaned = samePhysicalStore(claim.store, params.destination)
        ? await migrateClaimsInPlace({
            beforePersistentApply: params.beforePersistentApply,
            aliases: [claim],
            canonical,
            canonicalKey: params.canonicalKey,
            env: params.env,
            store: params.destination,
            winner: canonical,
          })
        : await deleteExpectedClaim(claim, params.beforePersistentApply);
      if (!cleaned) {
        return { quarantinedKeys, resolved: false };
      }
      continue;
    }
    const quarantineKey = await quarantineClaim({
      beforePersistentApply: params.beforePersistentApply,
      claim,
      env: params.env,
      ownerAgentId: params.ownerAgentId,
    });
    if (!quarantineKey) {
      return { quarantinedKeys, resolved: false };
    }
    quarantinedKeys.push(quarantineKey);
  }
  return { quarantinedKeys, resolved: true };
}
