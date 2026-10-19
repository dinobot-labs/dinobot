import type { ExternalDependency } from "../types.ts";

export const CUA_DRIVER_ID = "cua-driver";
export const CUA_DRIVER_VERSION = "0.34.0";

const RELEASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}`;

const MACOS_DIR = `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal`;
const MACOS_APP = {
	url: `${RELEASE}/${MACOS_DIR}.tar.gz`,
	sha256: "2d0ade531c07b4d16e8078844fe1b63a0dfa0ee19677c9dcc079b4d3460ab387",
	bytes: 75_844_139,
	format: "tar.gz",
	entry: `${MACOS_DIR}/CuaDriver.app/Contents/MacOS/cua-driver`,
	macosApp: { bundle: `${MACOS_DIR}/CuaDriver.app`, bundleId: "com.trycua.driver", teamId: "YCK386LBJ7", permissionArgs: ["permissions", "grant"] },
} as const;

/**
 * Pinned cua-driver release (trycua/cua, MIT). Digests and sizes are the release's published SHA256SUMS, re-checked
 * against downloaded archives. The `-binary` archives are flat and carry the `cua-driver` executable at the root.
 * Windows ZIPs retain the companion executables and DLL beside cua-driver.exe. macOS uses the universal directory
 * archive: its notarized CuaDriver.app (team YCK386LBJ7) is installed to /Applications, because Accessibility and
 * Screen Recording grants and the driver's LaunchServices daemon relaunch key on that identity and path (ADR 0071).
 */
export const CUA_DRIVER: ExternalDependency = {
	id: CUA_DRIVER_ID,
	version: CUA_DRIVER_VERSION,
	summary: "cua-driver: background computer-use driver (MCP over stdio) used by the computer plugin",
	homepage: "https://github.com/trycua/cua/tree/main/libs/cua-driver",
	license: "MIT",
	artifacts: {
		"darwin-arm64": MACOS_APP,
		"darwin-x64": MACOS_APP,
		"win32-x64": {
			url: `${RELEASE}/cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
			sha256: "bcc520e50861c7092cf775846fec76ae386d7dcd6b5b408608b0ea4423a8b888",
			bytes: 31_314_221,
			format: "zip",
			entry: "cua-driver.exe",
		},
		"win32-arm64": {
			url: `${RELEASE}/cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
			sha256: "df5786c6e7841d2f0d88f31c627c487181463ed99614b03efc0e907acfc698c3",
			bytes: 29_454_268,
			format: "zip",
			entry: "cua-driver.exe",
		},
		"linux-x64": {
			url: `${RELEASE}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
			sha256: "629ac96eff829d4dfd5cf221f3f2165c2d813aed91e5efb7b20777a741cd70a7",
			bytes: 34_818_314,
			format: "tar.gz",
			entry: "cua-driver",
		},
		"linux-arm64": {
			url: `${RELEASE}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64-binary.tar.gz`,
			sha256: "9db8b9084add57eb97be8164367b24b6be54ed4f3dc01213e64b72d7fc09fddb",
			bytes: 34_607_515,
			format: "tar.gz",
			entry: "cua-driver",
		},
	},
	check: { args: ["--version"], expect: `cua-driver ${CUA_DRIVER_VERSION}`, env: { DO_NOT_TRACK: "1", CUA_DRIVER_RS_UPDATE_CHECK: "0" } },
	manualInstall: "install cua-driver from https://cua.ai/docs/cua-driver and set plugins.computer.command to its path",
};

/** Desktop-session variables the driver needs to reach the display, accessibility bus and compositor. */
const PASSTHROUGH = [
	"HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
	"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP",
	"XDG_CURRENT_DESKTOP", "XDG_DATA_DIRS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DESKTOP_SESSION",
	"DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "HYPRLAND_INSTANCE_SIGNATURE", "SWAYSOCK",
	"SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP",
];

/**
 * Child environment: an allowlist of the parent's desktop-session variables plus `CUA_*` settings, never the
 * parent's other variables (provider tokens stay out of the driver). Telemetry and the startup update check are
 * off because dinobot pins the version. A Wayland session turns on the driver's opt-in native Wayland backend;
 * without it the driver sees no Wayland windows. Explicit `extra` values win over all of this.
 */
export function driverEnvironment(parent: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(parent)) {
		if (value !== undefined && (PASSTHROUGH.includes(name) || name.startsWith("CUA_"))) env[name] = value;
	}
	env.DO_NOT_TRACK = "1";
	env.CUA_DRIVER_RS_UPDATE_CHECK = "0";
	if (parent.WAYLAND_DISPLAY && env.CUA_DRIVER_RS_ENABLE_WAYLAND === undefined) env.CUA_DRIVER_RS_ENABLE_WAYLAND = "1";
	return { ...env, ...extra };
}
