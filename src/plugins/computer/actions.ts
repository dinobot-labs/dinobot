/**
 * cua-driver tools that `computer_use` forwards. The schema lists this fixed set so the prompt stays small and
 * stable; at run time the effective set is this list intersected with what the running driver serves.
 *
 * Left out on purpose: driver maintenance and network installs (`check_for_update`, `install_ffmpeg`,
 * `install_extension`, `set_config`, `get_config`), the AGPL perception extension (`parse_visual_regions`),
 * recording and replay, deprecated session tools, cosmetic agent-cursor settings, file transfer through the
 * browser (`browser_set_input_files`, `browser_download`), `kill_app` (force kill) and `parallel_mouse_drag`.
 */
export const ACTIONS = [
	// Observe
	"list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state", "get_screen_size",
	"get_cursor_position", "zoom", "verify_state", "health_report", "check_permissions",
	// Apps and windows
	"launch_app", "bring_to_front", "set_window_frame", "invoke_menu",
	// Pointer
	"click", "double_click", "right_click", "drag", "scroll", "move_cursor", "mouse_button_down", "mouse_drag", "mouse_button_up",
	// Keyboard and values
	"type_text", "press_key", "hotkey", "set_value",
	// Clipboard
	"clipboard_read", "clipboard_write",
	// Browser pages
	"page", "get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type", "browser_dialog", "browser_pointer",
	// Sessions
	"start_session", "get_session", "list_sessions", "end_session",
] as const;

export const DESCRIBE = "describe";

/**
 * Plugin-level actions of the v2 layer: `windows` (compact list_windows) and `observe` (get_window_state with
 * agent-friendly defaults). They run on the driver's list_windows and get_window_state.
 */
export const FRIENDLY_ACTIONS = ["windows", "observe"] as const;

/**
 * Driver actions that deliver input to a window. Only these are retried in the foreground after a
 * `background_unavailable` refusal and checked by the pixel coordinate-frame guard.
 */
export const INPUT_ACTIONS: ReadonlySet<string> = new Set([
	"click", "double_click", "right_click", "drag", "scroll", "move_cursor", "mouse_button_down", "mouse_drag", "mouse_button_up",
	"type_text", "press_key", "hotkey", "set_value",
]);
