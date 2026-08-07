import { type Component, Container, getKeybindings, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	private maxVisible: number = 10; // Max messages visible

	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// Store messages in chronological order (oldest to newest)
		this.messages = messages;
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// Start with selected message if provided, else default to the most recent
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// Calculate visible range with scrolling
		// Render every message block (message text wrapped + metadata + blank line)
		const blocks: string[][] = [];
		for (let i = 0; i < this.messages.length; i++) {
			blocks.push(this.renderMessageBlock(i, width));
		}

		// Line-aware window containing the selection: messages may wrap to
		// multiple lines, so paginate by total line count, not message count.
		const heights = blocks.map((block) => block.length);
		let startIndex = 0;
		let endIndex = blocks.length;
		if (heights.reduce((a, b) => a + b, 0) > this.maxVisible) {
			let used = 0;
			for (let i = 0; i < blocks.length; i++) {
				const h = heights[i]!;
				if (used + h > this.maxVisible) {
					if (i > this.selectedIndex) break;
					// Drop blocks from the top until this block fits (or it is the only block).
					while (startIndex < i && used + h > this.maxVisible) {
						used -= heights[startIndex]!;
						startIndex++;
					}
				}
				used += h;
				endIndex = i + 1;
			}
			// Safety: the selection must be inside the window.
			if (this.selectedIndex >= endIndex) {
				startIndex = this.selectedIndex;
				endIndex = this.selectedIndex + 1;
			}
		}

		// Render visible message blocks
		for (let i = startIndex; i < endIndex; i++) {
			lines.push(...blocks[i]!);
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	/**
	 * Render one message: the text wraps instead of truncating, followed by
	 * metadata and a blank separator line.
	 */
	private renderMessageBlock(i: number, width: number): string[] {
		const lines: string[] = [];
		const message = this.messages[i];
		const isSelected = i === this.selectedIndex;

		// Normalize message to a single logical line
		const normalizedMessage = message.text.replace(/\n/g, " ").trim();

		// First line: cursor + message; continuations align under the message
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const maxMsgWidth = Math.max(10, width - 2); // Account for cursor (2 chars)
		const msgLines = wrapTextWithAnsi(normalizedMessage, maxMsgWidth);
		for (let k = 0; k < msgLines.length; k++) {
			const msgLine = msgLines[k]!;
			lines.push((k === 0 ? cursor : "  ") + (isSelected ? theme.bold(msgLine) : msgLine));
		}

		// Metadata (position in history)
		const position = i + 1;
		const metadata = `  Message ${position} of ${this.messages.length}`;
		lines.push(theme.fg("muted", metadata));
		lines.push(""); // Blank line between messages
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter - select message and branch
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create message list
		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
