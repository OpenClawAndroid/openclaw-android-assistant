export const databaseWorkerExtensionTestRoots = [
  "extensions/logbook",
  "extensions/team-reports",
  "extensions/workboard",
];

export const databaseWorkerExtensionTestFiles = [
  "extensions/imessage/src/approval-reactions.persistence.test.ts",
  "extensions/imessage/src/send.sqlite.test.ts",
];

export function isDatabaseWorkerExtensionRoot(root) {
  return databaseWorkerExtensionTestRoots.includes(root);
}
