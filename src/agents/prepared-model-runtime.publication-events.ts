import { isDeepStrictEqual } from "node:util";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedModelRuntimeCatalogFacts } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelCatalogAcquisitionKind,
  PreparedModelCatalogAttempt,
  PreparedModelCatalogInventory,
  PreparedModelRuntimeOwner,
} from "./prepared-model-runtime.types.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");

type PreparedModelRuntimePublicationEvent =
  | { phase: "invalidated" | "published" }
  | { phase: "failed"; error: Error }
  // Only the catalog commit owner can prove that model facts stayed unchanged.
  | { phase: "catalog-published"; modelFactsChanged?: boolean }
  | { phase: "catalog-failed"; error: Error; modelFactsChanged?: boolean };

type CatalogPublication = {
  catalog: ModelCatalogSnapshot | undefined;
  runtimeModels: PreparedModelCatalogInventory["runtimeModels"] | undefined;
  configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"];
};
type CatalogPublicationChange = { previous: CatalogPublication; current: CatalogPublication };

// Include route and runtime facts as well as logical rows; attempt status is not model metadata.
function modelFacts(publication: CatalogPublication) {
  return [
    publication.catalog?.entries,
    publication.catalog?.routeVariants,
    publication.catalog?.staticEntries,
    publication.runtimeModels,
    publication.configuredRuntimeModels,
  ];
}

/** Reports model changes only after the catalog owner commits its complete publication. */
export function notifyPreparedModelCatalogPublication(
  change: CatalogPublicationChange | undefined,
): void {
  notifyPreparedModelRuntimePublication({
    phase: "catalog-published",
    modelFactsChanged:
      change !== undefined &&
      !isDeepStrictEqual(modelFacts(change.previous), modelFacts(change.current)),
  });
}

const publicationListeners = new Set<(event: PreparedModelRuntimePublicationEvent) => void>();

/** Completes catalog attempts without withdrawing their prepared turn runtime. */
export function createCatalogAttemptReporter(
  owner: Pick<PreparedModelRuntimeOwner, "catalogAttempt">,
  source: PreparedModelCatalogAttempt["source"],
  isCurrent: () => boolean,
): {
  started: (providers: readonly string[], kind?: PreparedModelCatalogAcquisitionKind) => void;
  published: (
    providers?: readonly string[],
    kind?: PreparedModelCatalogAcquisitionKind,
    publication?: CatalogPublicationChange,
  ) => void;
  failed: (
    error: unknown,
    providers?: readonly string[],
    kind?: PreparedModelCatalogAcquisitionKind,
  ) => void;
  withRefreshStatus: (catalog: ModelCatalogSnapshot) => ModelCatalogSnapshot;
} {
  // Compatible reloads share live status; replacement sources start without the old error.
  const attempt: PreparedModelCatalogAttempt =
    owner.catalogAttempt && isDeepStrictEqual(owner.catalogAttempt.source, source)
      ? owner.catalogAttempt
      : { source, failedProviders: { provider: new Set(), native: new Set() } };
  let pendingProviders: readonly string[] = [];
  let pendingKind: PreparedModelCatalogAcquisitionKind = "provider";
  return {
    started: (providers, kind = "provider") => {
      pendingProviders = providers;
      pendingKind = kind;
      notifyPreparedModelRuntimePublication({
        phase: "catalog-published",
        modelFactsChanged: false,
      });
    },
    withRefreshStatus: (catalog) => {
      // Provider renewal does not retry a failed native inventory.
      if (attempt.failedProviders.native.size > 0) {
        catalog.authoritative = false;
      }
      Object.defineProperty(catalog, "pendingProviders", {
        enumerable: true,
        configurable: true,
        get: () => (pendingProviders.length ? pendingProviders : undefined),
      });
      // Keep the status live on retained inventory without copying an error into its successor.
      Object.defineProperty(catalog, "refreshFailed", {
        enumerable: true,
        configurable: true,
        get: () =>
          attempt.failedProviders.provider.size > 0 ||
          attempt.failedProviders.native.size > 0 ||
          catalog.providerOutcomes?.some((outcome) => outcome.status !== "ready") ||
          undefined,
      });
      return catalog;
    },
    published: (providers, kind, publication) => {
      const acquisitionKind = kind ?? "provider";
      pendingProviders = providers
        ? pendingProviders.filter((provider) => !providers.includes(provider))
        : [];
      if (providers) {
        for (const provider of providers) {
          attempt.failedProviders[acquisitionKind].delete(provider);
        }
      } else {
        attempt.failedProviders[acquisitionKind].clear();
      }
      owner.catalogAttempt = attempt;
      notifyPreparedModelCatalogPublication(publication);
    },
    failed: (error, providers = pendingProviders, kind = pendingKind) => {
      if (isCurrent() && !(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        const attemptError = toStringifiedError(error);
        for (const provider of providers.length ? providers : [undefined]) {
          attempt.failedProviders[kind].add(provider);
        }
        pendingProviders = [];
        owner.catalogAttempt = attempt;
        notifyPreparedModelRuntimePublication({
          phase: "catalog-failed",
          error: attemptError,
          modelFactsChanged: false,
        });
      }
    },
  };
}

/** Observes committed prepared model/auth generations without starting discovery. */
export function registerPreparedModelRuntimePublicationListener(
  listener: (event: PreparedModelRuntimePublicationEvent) => void,
): () => void {
  publicationListeners.add(listener);
  return () => publicationListeners.delete(listener);
}

export function notifyPreparedModelRuntimePublication(
  event: PreparedModelRuntimePublicationEvent,
): void {
  for (const listener of publicationListeners) {
    try {
      listener(event);
    } catch (error) {
      log.warn(`prepared model runtime publication listener failed: ${String(error)}`);
    }
  }
}

export function resetPreparedModelRuntimePublicationListenersForTest(): void {
  publicationListeners.clear();
}
