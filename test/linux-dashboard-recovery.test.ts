import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "vitest";
import { createDeferred } from "./helpers/promise.js";

const dashboardSource = readFileSync(new URL("../apps/linux/ui/main.js", import.meta.url), "utf8");

function fakeElement() {
  const classes = new Set(["hidden"]);
  const listeners = new Map<string, () => unknown>();
  return {
    className: "",
    classList: {
      contains: (name: string) => classes.has(name),
      toggle(name: string, force?: boolean) {
        const enabled = force ?? !classes.has(name);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
    disabled: false,
    textContent: "",
    value: "stable",
    addEventListener(event: string, listener: () => unknown) {
      listeners.set(event, listener);
    },
    click() {
      return listeners.get("click")?.();
    },
    append() {},
    removeAttribute() {},
    replaceChildren() {},
    setAttribute() {},
  };
}

test("missing CLI mode offers installation without retrying bootstrap", async () => {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const invoked: string[] = [];
  const document = {
    createElement: fakeElement,
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, fakeElement());
      }
      return elements.get(selector);
    },
  };
  const window = {
    __TAURI__: {
      core: {
        invoke(command: string) {
          invoked.push(command);
          if (command === "discover_gateways") {
            return Promise.resolve([]);
          }
          return Promise.resolve({ phase: "connected" });
        },
      },
      event: { listen: async () => () => {} },
    },
    location: { search: "?mode=missingCli" },
    setInterval() {},
  };

  await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
    document,
    URLSearchParams,
    window,
  });

  assert.equal(elements.get("#title")?.textContent, "OpenClaw needs the CLI");
  assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
  assert.equal(invoked.includes("bootstrap"), false);
});

test("CLI recovery errors offer both retry and reinstall", async () => {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const document = {
    createElement: fakeElement,
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, fakeElement());
      }
      return elements.get(selector);
    },
  };
  const window = {
    __TAURI__: {
      core: { invoke: () => Promise.resolve([]) },
      event: { listen: async () => () => {} },
    },
    location: { search: "?mode=error" },
    setInterval() {},
  };

  await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
    document,
    URLSearchParams,
    window,
  });

  assert.equal(elements.get("#primary-action")?.textContent, "Try again");
  assert.equal(elements.get("#action-controls")?.classList.contains("hidden"), false);
  assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
});

test.each([
  { name: "local", remote: null, failure: false, entry: "settings", lateRetry: false },
  {
    name: "remote",
    remote: { transport: "direct", url: "https://gateway.example.com" },
    failure: false,
    entry: "settings",
    lateRetry: false,
  },
  { name: "failed return", remote: null, failure: true, entry: "settings", lateRetry: false },
  { name: "startup error Edit", remote: null, failure: false, entry: "startup", lateRetry: false },
  {
    name: "late retry after Edit",
    remote: null,
    failure: false,
    entry: "startup",
    lateRetry: true,
  },
  { name: "recovery return", remote: null, failure: false, entry: "recovery", lateRetry: false },
])(
  "Connection Settings preserves a native Back action for $name",
  async ({ remote, failure, entry, lateRetry }) => {
    const elements = new Map<string, ReturnType<typeof fakeElement>>();
    const invoked: Array<{ command: string; args: unknown }> = [];
    const retry = createDeferred<{ phase: string }>();
    const document = {
      createElement: fakeElement,
      querySelector(selector: string) {
        if (!elements.has(selector)) {
          elements.set(selector, fakeElement());
        }
        return elements.get(selector);
      },
    };
    const window = {
      __TAURI__: {
        core: {
          async invoke(
            command: string,
            args?: { connectionSettings?: boolean; remoteRetry?: boolean },
          ) {
            invoked.push({ command, args });
            if (command === "bootstrap") {
              if (args?.remoteRetry) {
                return retry.promise;
              }
              return args?.connectionSettings ? { remote } : { phase: "remoteError" };
            }
            if (command === "close_connection_settings" && failure) {
              throw new Error("The previous dashboard is unavailable. Try again.");
            }
            return [];
          },
        },
        event: { listen: async () => () => {} },
      },
      location: {
        search:
          entry === "settings"
            ? "?mode=connectionSettings"
            : entry === "recovery"
              ? "?mode=remoteError"
              : "",
      },
      setInterval() {},
    };

    await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
      document,
      URLSearchParams,
      window,
    });

    if (entry !== "settings") {
      assert.equal(elements.get("#title")?.textContent, "Connection needs attention");
      if (entry === "recovery") {
        assert.equal(
          invoked.some(({ command }) => command === "bootstrap"),
          false,
        );
      }
      if (lateRetry) {
        elements.get("#primary-action")?.click();
      }
      elements.get("#edit-connection")?.click();
      // Drain the actual click's promise continuations, without changing the handler.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (lateRetry) {
        retry.resolve({ phase: "remoteError" });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      assert.equal(elements.get("#title")?.textContent, "Connection Settings");
    }
    assert.equal(elements.get(".setup-navigation")?.classList.contains("hidden"), false);
    assert.equal(elements.get("#setup-continue")?.classList.contains("hidden"), true);
    assert.equal(elements.get("#setup-back")?.disabled, false);
    const beforeBack = invoked.length;
    await elements.get("#setup-back")?.click();
    assert.deepEqual(invoked.slice(beforeBack), [
      { command: "close_connection_settings", args: undefined },
    ]);
    assert.equal(elements.get("#setup-back")?.disabled, false);
    if (failure) {
      assert.equal(elements.get("#title")?.textContent, "Connection Settings");
      assert.equal(elements.get(".setup-navigation")?.classList.contains("hidden"), false);
      assert.match(
        elements.get("#remote-feedback")?.textContent ?? "",
        /previous dashboard is unavailable/,
      );
    }
  },
);

test.each(
  [
    { platform: "freebsd", externalService: true },
    { platform: "linux", externalService: false },
    { platform: "macos", externalService: false },
    { platform: "windows", externalService: false },
  ].flatMap((entry) => [true, false].map((releaseBuild) => ({ ...entry, releaseBuild }))),
)(
  "$platform first-run describes its local service ownership (release: $releaseBuild)",
  async ({ platform, externalService, releaseBuild }) => {
    for (const phase of ["unconfigured", "missingCli"]) {
      const installFailure = "Fixture: start the Gateway with openclaw gateway run, then retry.";
      const elements = new Map<string, ReturnType<typeof fakeElement>>();
      const invoked: { command: string; args?: Record<string, unknown> }[] = [];
      const document = {
        createElement: fakeElement,
        querySelector(selector: string) {
          if (!elements.has(selector)) elements.set(selector, fakeElement());
          return elements.get(selector);
        },
      };
      const window = {
        __TAURI__: {
          core: {
            async invoke(command: string, args?: Record<string, unknown>) {
              invoked.push({ command, args });
              if (command === "discover_gateways") return [];
              if (command === "build_info") return { platform, releaseBuild };
              if (command === "install_cli") throw new Error(installFailure);
              return { phase };
            },
          },
          event: { listen: async () => () => {} },
        },
        location: { search: "" },
        setInterval() {},
      };
      const actions = await vm.runInNewContext(
        `(async () => { ${dashboardSource}\nreturn { renderConnectionChoices, continueLocalSetup, install }; })()`,
        { document, URLSearchParams, window },
      );
      actions.renderConnectionChoices();
      const description = elements.get("#description")?.textContent ?? "";
      const subtitle = elements.get("#local-subtitle")?.textContent ?? "";
      if (externalService) {
        assert.match(description, /openclaw package service/);
        assert.match(description, /openclaw gateway run/);
        assert.match(description, /same account you used for onboarding/);
        assert.match(subtitle, /Gateway you start/);
        assert.doesNotMatch(
          `${description} ${subtitle}`,
          /starts automatically|installs everything/,
        );
      } else {
        assert.equal(
          description,
          "Most people choose this computer. OpenClaw installs everything and keeps your assistant running in the background.",
        );
        assert.equal(subtitle, "Private to this computer. Installs and starts automatically.");
      }

      await actions.continueLocalSetup();
      assert.equal(
        elements.get("#install-hint")?.textContent,
        externalService
          ? "Installs the CLI in ~/.openclaw using your system Node.js and npm."
          : "Installs the CLI and managed Node runtime in ~/.openclaw.",
      );
      if (phase === "unconfigured") {
        assert.deepEqual(
          invoked
            .filter(({ command }) => command === "bootstrap")
            .map(({ args }) => args && { ...args }),
          [undefined, { explicitLocal: true }],
        );
        assert.equal(
          elements.get("#activity-label")?.textContent,
          externalService ? "Connecting to your local Gateway…" : "Starting your local Gateway…",
        );
      } else if (!releaseBuild) {
        assert.equal(elements.get("#title")?.textContent, "Choose a release channel");
        if (externalService) {
          assert.match(elements.get("#description")?.textContent ?? "", /system Node.js and npm/);
        }
        assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
        assert.equal(
          invoked.some(({ command }) => command === "install_cli"),
          false,
        );
        await actions.install();
      }
      if (phase === "missingCli") {
        assert.equal(elements.get("#title")?.textContent, "OpenClaw needs attention");
        assert.equal(elements.get("#description")?.textContent, installFailure);
        assert.equal(elements.get("#log-status")?.textContent, "FAILED");
        assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
        assert.equal(elements.get("#install-button")?.disabled, false);
      }
      assert.equal(
        invoked.filter(({ command }) => command === "install_cli").length,
        phase === "missingCli" ? 1 : 0,
      );
      assert.equal(
        invoked.some(({ command }) => command === "gateway_action"),
        false,
      );
    }
  },
);
