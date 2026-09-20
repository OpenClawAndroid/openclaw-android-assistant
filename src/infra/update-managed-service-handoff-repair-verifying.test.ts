// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { describe, it } from "vitest";
import { registerManagedRepairAuthorityTests } from "./update-managed-service-handoff-repair.test-support.js";

const { runManagedServiceManagerBoundary } = useManagedServiceHandoffLifecycleFixture();

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedRepairAuthorityTests(runManagedServiceManagerBoundary, "verifying", itUnix);
});
