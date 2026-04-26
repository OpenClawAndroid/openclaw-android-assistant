---
name: openclaw-testing
description: Choose, run, rerun, or debug OpenClaw tests, CI checks, Docker E2E lanes, release validation, and the cheapest safe verification path.
---

# OpenClaw Testing

Use this skill when deciding what to test, debugging failures, rerunning CI,
or validating a change without wasting hours.

## Read First

- `docs/reference/test.md` for local test commands.
- `docs/ci.md` for CI scope, release checks, Docker chunks, and runner behavior.
- Scoped `AGENTS.md` files before editing code under a subtree.

## Default Rule

Prove the touched surface first. Do not reflexively run the whole suite.

1. Inspect the diff and classify the touched surface:
   - source: `pnpm changed:lanes --json`, then `pnpm check:changed`
   - tests only: `pnpm test:changed`
   - one failing file: `pnpm test <path-or-filter> -- --reporter=verbose`
   - workflow-only: `git diff --check`, workflow syntax/lint (`actionlint` when available)
   - docs-only: `pnpm docs:list`, docs formatter/lint only if docs tooling changed or requested
2. Reproduce narrowly before fixing.
3. Fix root cause.
4. Rerun the same narrow proof.
5. Broaden only when the touched contract demands it.

## Guardrails

- Do not kill unrelated processes or tests. If something is running elsewhere, treat it as owned by the user or another agent.
- Do not run expensive local Docker, full release checks, full `pnpm test`, or full `pnpm check` unless the user asks or the change genuinely requires it.
- Prefer GitHub Actions for release/Docker proof when the workflow already has the prepared image and secrets.
- Use `scripts/committer "<msg>" <paths...>` when committing; stage only your files.
- If deps are missing, run `pnpm install`, retry once, then report the first actionable error.

## Local Test Shortcuts

```bash
pnpm changed:lanes --json
pnpm check:changed
pnpm test:changed
pnpm test:changed:focused
pnpm test <path-or-filter> -- --reporter=verbose
OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test <path-or-filter>
```

Use targeted file paths whenever possible. Avoid raw `vitest`; use the repo
`pnpm test` wrapper so project routing, workers, and setup stay correct.

## CI Debugging

Start with current run state, not logs for everything:

```bash
gh run list --branch main --limit 10
gh run view <run-id> --json status,conclusion,headSha,url,jobs
gh run view <run-id> --job <job-id> --log
```

- Check exact SHA. Ignore newer unrelated `main` unless asked.
- For cancelled same-branch runs, confirm whether a newer run superseded it.
- Fetch full logs only for failed or relevant jobs.

## Docker

Docker is expensive. First inspect the scheduler without running Docker:

```bash
OPENCLAW_DOCKER_ALL_DRY_RUN=1 pnpm test:docker:all
OPENCLAW_DOCKER_ALL_DRY_RUN=1 OPENCLAW_DOCKER_ALL_LANES=install-e2e pnpm test:docker:all
```

Run one failed lane locally only when explicitly asked or when GitHub is not
usable:

```bash
OPENCLAW_DOCKER_ALL_LANES=<lane> \
OPENCLAW_DOCKER_ALL_BUILD=0 \
OPENCLAW_DOCKER_ALL_PREFLIGHT=0 \
OPENCLAW_SKIP_DOCKER_BUILD=1 \
OPENCLAW_DOCKER_E2E_BARE_IMAGE='<prepared-bare-image>' \
OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE='<prepared-functional-image>' \
pnpm test:docker:all
```

For release validation, prefer the reusable GitHub workflow input:

```yaml
docker_lanes: install-e2e
```

Multiple lanes are allowed:

```yaml
docker_lanes: install-e2e bundled-channel-update-acpx
```

That skips the three chunk matrix and runs one targeted Docker job against the
prepared GHCR images and the prepared OpenClaw npm tarball. Live-only targeted
reruns skip the E2E images and build only the live-test image. Release-path
normal mode remains max three Docker chunk jobs:

- `core`
- `package-update`
- `plugins-integrations`

Docker E2E images never copy repo sources as the app under test: the bare image
is a Node/Git runner, and the functional image installs the same prebuilt npm
tarball that bare lanes mount. Every scheduler run writes
`.artifacts/docker-tests/**/summary.json`. Read it
before rerunning. Lane entries include `command`, `rerunCommand`, status,
timing, timeout state, image kind, and log file path. The summary also includes
top-level phase timings for preflight, image build, package prep, lane pools,
and cleanup.

## Docker Expected Timings

Treat these as ballpark. Blacksmith queue time, GHCR pull speed, provider
latency, npm cache state, and Docker daemon health can dominate.

Current local timing artifact (`.artifacts/docker-tests/lane-timings.json`) has
these rough bands:

- Tiny lanes, seconds to under 1 minute:
  `agents-delete-shared-workspace` ~3s, `plugin-update` ~7s,
  `config-reload` ~14s, `pi-bundle-mcp-tools` ~15s, `onboard` ~18s,
  `session-runtime-context` ~20s, `gateway-network` ~34s, `qr` ~44s.
- Medium deterministic lanes, ~1-5 minutes:
  `npm-onboard-channel-agent` ~96s, `openai-image-auth` ~99s,
  bundled channel/update lanes usually ~90-300s, `openwebui` ~225s,
  `mcp-channels` ~274s.
- Heavy deterministic lanes, ~6-10 minutes:
  `bundled-channel-root-owned` ~429s,
  `bundled-channel-setup-entry` ~420s,
  `bundled-channel-load-failure` ~383s,
  `cron-mcp-cleanup` ~567s.
- Live provider lanes, often ~15-20 minutes:
  `live-gateway` ~958s, `live-models` ~1054s.
- Installer/release lanes:
  `install-e2e` and package-update paths can vary widely with npm, provider,
  and package registry behavior. Budget tens of minutes; prefer GitHub targeted
  reruns over local repeats.

Default fallback lane timeout is 120 minutes. A timeout usually means debug the
lane log/artifacts first, not “run the whole thing again.”

## Failure Workflow

1. Identify exact failing job, SHA, lane, and artifact path.
2. Read `summary.json` and the failed lane log tail.
3. If the lane has `rerunCommand`, use that command as the starting point.
4. For Docker release failures, dispatch `docker_lanes=<failed-lane>` on GitHub
   before considering local Docker.
5. Patch narrowly, then rerun the failed file/lane only.
6. Broaden to `pnpm check:changed` or CI only after the isolated proof passes.

## When To Escalate

- Public SDK/plugin contract changes: run changed gate plus relevant extension
  validation.
- Build output, lazy imports, package boundaries, or published surfaces:
  include `pnpm build`.
- Workflow edits: run `actionlint` or equivalent workflow sanity.
- Release branch or tag validation: use release docs and GitHub workflows; avoid
  local Docker unless Peter explicitly asks.
