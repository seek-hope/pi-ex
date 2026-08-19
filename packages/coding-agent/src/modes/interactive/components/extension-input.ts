/**
 * Simple text input component for extensions.
 */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * Input that renders bullets instead of the typed value (password entry).
 * Editing behavior is inherited unchanged; only the display is masked.
 */
class MaskedInput extends Input {
	override render(width: number): string[] {
		const prompt = "> ";
		const value = this.getValue();
		const bullets = "\u2022".repeat([...value].length);
		const available = Math.max(0, width - prompt.length);
		const visible = bullets.slice(0, available);
		const cursor = this.focused ? "\x1b[7m \x1b[27m" : "";
		return [`${prompt}${visible}${cursor}`];
	}
}

export interface ExtensionInputOptions {
	tui?: TUI;
	timeout?: number;
	/** Render bullets instead of the typed value (password entry). */
	masked?: boolean;
}

export class ExtensionInputComponent extends Container implements Focusable {
	private input: Input;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		title: string,
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: ExtensionInputOptions,
	) {
		super();

		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", `${this.baseTitle} (${s}s)`)),
				() => this.onCancelCallback(),
			);
		}

		this.input = opts?.masked ? new MaskedInput() : new Input();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onSubmitCallback(this.input.getValue());
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.input.handleInput(keyData);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
