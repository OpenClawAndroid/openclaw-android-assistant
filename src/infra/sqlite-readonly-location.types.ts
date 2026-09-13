export type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  cleanupAsync: () => Promise<boolean>;
  location: string;
};
