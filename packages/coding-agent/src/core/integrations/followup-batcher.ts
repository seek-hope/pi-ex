/**
 * Unified debounce queue for integration-originated follow-up messages.
 *
 * Background-task completions (local and SSH), monitor results, and other
 * integration notifications each used to deliver their own follow-up, so
 * several events landing close together produced several separate input
 * turns — especially painful when the agent is idle (each delivery starts
 * its own run).
 *
 * All integration follow-ups now funnel through one batcher: events within
 * the debounce window merge into a single message (one turn). The window is
 * deliberately longer than the per-integration 1s batchers because SSH task
 * completion *detection* is quantized by per-task poll loops (3-5s tick +
 * round trips), so simultaneously-finished tasks are reported a few seconds
 * apart.
 */
export class IntegrationFollowUpBatcher {
	private pending: string[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly deliver: (text: string) => void;
	private readonly debounceMs: number;

	/**
	 * @param deliver Called once per merged batch with the final text.
	 * @param debounceMs Quiet window before delivery; each new event resets it.
	 */
	constructor(deliver: (text: string) => void, debounceMs = 3000) {
		this.deliver = deliver;
		this.debounceMs = debounceMs;
	}

	/** Queue a message part; delivers after the debounce window goes quiet. */
	push(text: string): void {
		this.pending.push(text);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, this.debounceMs);
	}

	/** Deliver any queued parts now (no-op when empty). */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const parts = this.pending.splice(0);
		if (parts.length === 0) return;
		this.deliver(parts.length === 1 ? parts[0] : parts.join("\n\n---\n\n"));
	}

	/** Drop queued parts and cancel the timer (session teardown). */
	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending = [];
	}

	get pendingCount(): number {
		return this.pending.length;
	}
}
