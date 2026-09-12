export type PluginInstallTransaction = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const PLUGIN_INSTALL_TRANSACTION = Symbol.for("openclaw.pluginInstallTransaction");
const PLUGIN_INSTALL_TRANSACTION_REQUEST = Symbol.for("openclaw.pluginInstallTransactionRequest");
const PLUGIN_INSTALL_OWNER_MIGRATIONS = Symbol.for("openclaw.pluginInstallOwnerMigrations");
const settlements = new WeakMap<PluginInstallTransaction, Promise<void>>();

type PluginInstallTransactionRequest = {
  deferCommit: true;
  transactionSink?: PluginInstallTransaction[];
  assertOwned?: () => void;
};

export function attachPluginInstallTransaction<T extends object>(
  result: T,
  transaction: PluginInstallTransaction,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_TRANSACTION, {
    configurable: true,
    enumerable: true,
    value: transaction,
  });
  return result;
}

export function resolvePluginInstallTransaction(
  result: object,
): PluginInstallTransaction | undefined {
  return (result as { [PLUGIN_INSTALL_TRANSACTION]?: PluginInstallTransaction })[
    PLUGIN_INSTALL_TRANSACTION
  ];
}

export function takePluginInstallTransaction(result: object): PluginInstallTransaction | undefined {
  const transaction = resolvePluginInstallTransaction(result);
  Reflect.deleteProperty(result, PLUGIN_INSTALL_TRANSACTION);
  return transaction;
}

export function requestDeferredPluginInstall<T extends object>(
  params: T,
  transactionSink?: PluginInstallTransaction[],
  assertOwned?: () => void,
): T {
  Object.defineProperty(params, PLUGIN_INSTALL_TRANSACTION_REQUEST, {
    configurable: false,
    enumerable: true,
    value: {
      deferCommit: true,
      ...(transactionSink ? { transactionSink } : {}),
      ...(assertOwned ? { assertOwned } : {}),
    } satisfies PluginInstallTransactionRequest,
  });
  return params;
}

export function copyPluginInstallTransactionRequest<T extends object>(
  source: object,
  target: T,
): T {
  const request = resolvePluginInstallTransactionRequest(source);
  return request
    ? requestDeferredPluginInstall(target, request.transactionSink, request.assertOwned)
    : target;
}

export function resolvePluginInstallTransactionRequest(
  params: object,
): PluginInstallTransactionRequest | undefined {
  return (params as { [PLUGIN_INSTALL_TRANSACTION_REQUEST]?: PluginInstallTransactionRequest })[
    PLUGIN_INSTALL_TRANSACTION_REQUEST
  ];
}

export function attachPluginInstallOwnerMigrations<T extends object>(
  result: T,
  migrations: Readonly<Record<string, string>>,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_OWNER_MIGRATIONS, {
    configurable: false,
    enumerable: true,
    value: migrations,
  });
  return result;
}

export function resolvePluginInstallOwnerMigrations(
  result: object,
): Readonly<Record<string, string>> | undefined {
  return (result as { [PLUGIN_INSTALL_OWNER_MIGRATIONS]?: Readonly<Record<string, string>> })[
    PLUGIN_INSTALL_OWNER_MIGRATIONS
  ];
}

export async function settlePluginInstallTransactions(
  transactions: readonly PluginInstallTransaction[],
  action: "commit" | "rollback",
  primaryFailure?: { error: unknown },
): Promise<void> {
  const ordered = action === "rollback" ? transactions.toReversed() : transactions;
  const errors: unknown[] = [];
  for (const transaction of new Set(ordered)) {
    try {
      let settlement = settlements.get(transaction);
      if (!settlement) {
        settlement = Promise.resolve()
          .then(() => transaction[action]())
          .catch((error: unknown) => {
            // Failed I/O retains the directory owner's retryable rollback progress.
            settlements.delete(transaction);
            throw error;
          });
        settlements.set(transaction, settlement);
      }
      await settlement;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    const message = `Plugin install transaction ${action} failed`;
    throw primaryFailure
      ? new AggregateError(
          [primaryFailure.error, ...errors],
          `${String(primaryFailure.error)}; ${message}`,
          { cause: primaryFailure.error },
        )
      : new AggregateError(errors, message);
  }
}
