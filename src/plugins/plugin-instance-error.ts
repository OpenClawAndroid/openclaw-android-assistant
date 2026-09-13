/** A retired instance cannot admit a fresh invocation. */
export class PluginInstanceUnavailableError extends Error {
  constructor(pluginId?: string) {
    super(
      pluginId
        ? `Plugin ${pluginId} was reloaded or disabled; use its current tools.`
        : "Plugin tools changed during automation setup; use the current plugin runtime.",
    );
    this.name = "PluginInstanceUnavailableError";
  }
}
