/**
 * OS service installation.  GOVERNED BY: §6.2
 *
 * Three platforms, each behind a platform check. Installation failing is NEVER
 * fatal to `grasp init` (§6.2): it falls back to a detached child process and
 * warns that it will not survive a reboot.
 *
 * All three writers are pure functions of their inputs, so the file contents can
 * be asserted in tests on any platform; only the install/uninstall side effects
 * are platform-gated. CI stubs the side effects (§22.4).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { graspLogDir } from "../util/home.js";

export const LAUNCHD_LABEL = "com.grasp.daemon";
export const SYSTEMD_UNIT = "grasp.service";
export const WINDOWS_TASK = "GraspDaemon";

export type Platform = "darwin" | "linux" | "win32";

export interface ServiceTarget {
  /** Absolute path to the node binary. */
  node: string;
  /** Absolute path to the daemon entry script. */
  script: string;
}

export function launchAgentPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** §6.2 — RunAtLoad + KeepAlive, so it starts at login and restarts on crash. */
export function renderLaunchAgent(target: ServiceTarget, logDir = graspLogDir()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${target.node}</string>
    <string>${target.script}</string>
    <string>__daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, "daemon.out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, "daemon.err.log")}</string>
</dict>
</plist>
`;
}

/** §6.2 — a systemd USER service, not a system one; Restart=on-failure. */
export function renderSystemdUnit(target: ServiceTarget): string {
  return `[Unit]
Description=Grasp comprehension daemon
After=default.target

[Service]
Type=simple
ExecStart=${target.node} ${target.script} __daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface InstallResult {
  installed: boolean;
  mechanism: "launchd" | "systemd" | "schtasks" | "detached" | "none";
  /** Shown to the user; non-empty when the fallback was used (§6.2). */
  warning?: string;
}

export type ServiceRunner = (
  command: string,
  args: string[],
) => Promise<{ ok: boolean; stderr: string }>;

/** §7.4 — execFile with an argv array, never a shell string. */
export const defaultServiceRunner: ServiceRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (error, _stdout, stderr) => {
      resolve({ ok: !error, stderr: String(stderr ?? "") });
    });
  });

export interface InstallOptions {
  target: ServiceTarget;
  platform?: Platform | NodeJS.Platform;
  home?: string;
  run?: ServiceRunner;
  /** Injected so tests never spawn a real detached process. */
  spawnDetached?: () => boolean;
}

export async function installService(options: InstallOptions): Promise<InstallResult> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const run = options.run ?? defaultServiceRunner;

  try {
    if (platform === "darwin") {
      const file = launchAgentPath(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderLaunchAgent(options.target));
      // `bootstrap` is the modern verb; `load` is the fallback for older macOS.
      const loaded = await run("launchctl", [
        "bootstrap",
        `gui/${process.getuid?.() ?? 501}`,
        file,
      ]);
      if (!loaded.ok) await run("launchctl", ["load", "-w", file]);
      return { installed: true, mechanism: "launchd" };
    }

    if (platform === "linux") {
      const file = systemdUnitPath(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderSystemdUnit(options.target));
      const reloaded = await run("systemctl", ["--user", "daemon-reload"]);
      const enabled = await run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
      if (!reloaded.ok || !enabled.ok) throw new Error(enabled.stderr || "systemctl failed");
      return { installed: true, mechanism: "systemd" };
    }

    if (platform === "win32") {
      const created = await run("schtasks", [
        "/Create",
        "/TN",
        WINDOWS_TASK,
        "/SC",
        "ONLOGON",
        "/TR",
        `"${options.target.node}" "${options.target.script}" __daemon`,
        "/F",
      ]);
      if (!created.ok) throw new Error(created.stderr || "schtasks failed");
      return { installed: true, mechanism: "schtasks" };
    }

    return {
      installed: false,
      mechanism: "none",
      warning: `Grasp does not know how to install a background service on "${platform}".`,
    };
  } catch (error) {
    // §6.2 — never hard-fail init over service installation.
    const detached = options.spawnDetached?.() ?? false;
    return {
      installed: detached,
      mechanism: detached ? "detached" : "none",
      warning:
        `Could not install a background service (${error instanceof Error ? error.message : String(error)}). ` +
        (detached
          ? "Started Grasp as a detached process instead — it will not survive a reboot; re-run `grasp init` after restarting."
          : "Grasp is not running in the background; run `grasp enable` to try again."),
    };
  }
}

export async function uninstallService(options: InstallOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const run = options.run ?? defaultServiceRunner;

  if (platform === "darwin") {
    const file = launchAgentPath(home);
    const unloaded = await run("launchctl", [
      "bootout",
      `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`,
    ]);
    if (!unloaded.ok) await run("launchctl", ["unload", "-w", file]);
    fs.rmSync(file, { force: true });
    return;
  }
  if (platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    fs.rmSync(systemdUnitPath(home), { force: true });
    return;
  }
  if (platform === "win32") {
    await run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
  }
}
