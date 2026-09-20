// Defines local desktop sources for Gateway hosts and paired nodes.

export type DesktopHostConfig = {
  /** Gateway-host opt-in; paired desktop nodes default to enabled when unset. */
  enabled: boolean;
  /** Runs a gateway-supervised headless TigerVNC/XFCE desktop on Linux. */
  managed?: boolean;
  /** Loopback RFB port of an already-running VNC server (default: 5900). */
  port?: number;
  /** Absolute VNC password-file path; macOS ARD account credentials stay per-observation. */
  passwordFile?: string;
};

export type DesktopConfig = {
  /** Local desktop attachment settings; managed mode is Gateway-only. */
  host?: DesktopHostConfig;
};
