import { note } from "../../packages/terminal-core/src/note.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/state-dir.js";
import { inspectLegacyPluginSourceCaptureRoots } from "../plugins/plugin-source-capture-report.js";
import { formatBytes } from "./doctor-disk-space.js";

export async function noteLegacyPluginSourceCaptures(env: NodeJS.ProcessEnv): Promise<void> {
  const report = await inspectLegacyPluginSourceCaptureRoots(resolveStateDir(env));
  const lines: string[] = [];
  if (report.roots.length > 0) {
    lines.push(
      `${report.roots.length} legacy plugin capture root(s), ${formatBytes(report.totalBytes)} in known regular files under ${report.directory}.`,
      ...report.roots.map((root) => `- ${quoteCliArg(root.path)} (${formatBytes(root.bytes)})`),
      "Doctor leaves these roots unchanged, including with --fix; their producers have no custody token.",
      "Only after every Gateway, CLI process, and container using this state directory has stopped, remove these legacy roots manually in a POSIX shell:",
      `find -P ${quoteCliArg(report.directory)} -mindepth 1 -maxdepth 1 -type d \\( -name 'openclaw-plugin-build-*' -o -name 'openclaw-model-catalog-*' \\) -exec rm -rf -- {} +`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push(
      "Legacy capture inspection was incomplete; sizes may be partial.",
      ...report.warnings,
    );
  }
  if (lines.length > 0) {
    note(lines.join("\n"), "Legacy plugin captures");
  }
}
