/**
 * Transport-neutral interaction port.
 *
 * This interface is the UI-agnostic surface that higher-level controllers use
 * to request dialogs and notifications from the host. It intentionally has no
 * dependency on `@earendil-works/pi-tui`, the DOM, or extension types, so it can
 * be implemented by interactive (TUI), RPC, and print hosts alike.
 *
 * Semantics mirror the current `ExtensionUIContext` dialog contract:
 * `select`, `input`, and `editor` resolve to `undefined` when the user cancels,
 * while `confirm` resolves to a boolean.
 */

/** Shared options for interaction-port dialogs. */
export interface InteractionDialogOptions {
	/** AbortSignal that programmatically dismisses the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds after which the dialog auto-dismisses. */
	timeout?: number;
	/** Mask typed input (password entry). Only meaningful for `input`. */
	masked?: boolean;
}

/** Kind of user notification. */
export type NotificationKind = "info" | "warning" | "error";

/** Where a widget is rendered relative to the editor. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for placement of a text/string widget. */
export interface StringWidgetOptions {
	/** Where the widget is rendered. Defaults to "aboveEditor". */
	placement?: WidgetPlacement;
}

/**
 * Minimal, transport-neutral dialog and notification surface.
 *
 * Only the portable primitives needed by core flows are declared here. TUI
 * widgets, components, themes, and keybindings are intentionally out of scope.
 * Surface state methods (`setStatus`/`setWidget`/`setTitle`) accept only the
 * transport-neutral primitives that any host can render.
 */
export interface InteractionPort {
	/** Show a selector and resolve to the chosen option, or `undefined` if cancelled. */
	select(title: string, options: string[], opts?: InteractionDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog and resolve to the user's decision. */
	confirm(title: string, message: string, opts?: InteractionDialogOptions): Promise<boolean>;

	/** Show a text input dialog and resolve to the entered value, or `undefined` if cancelled. */
	input(title: string, placeholder?: string, opts?: InteractionDialogOptions): Promise<string | undefined>;

	/** Show a multi-line editor and resolve to the edited text, or `undefined` if cancelled. */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** Show a transient notification of the given kind. */
	notify(message: string, kind?: NotificationKind): void;

	/** Set status text for a key in the host's status bar. Pass `undefined` to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set a string widget rendered above or below the editor. Pass `undefined` to clear. */
	setWidget(key: string, lines: string | string[] | undefined, options?: StringWidgetOptions): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;
}
