export const databaseWorkerExtensionTestRoots = ["extensions/logbook", "extensions/team-reports"];

export const databaseWorkerExtensionTestFiles = [
  "extensions/imessage/src/approval-reactions.persistence.test.ts",
];

export function isDatabaseWorkerExtensionRoot(root) {
  return databaseWorkerExtensionTestRoots.includes(root);
}
