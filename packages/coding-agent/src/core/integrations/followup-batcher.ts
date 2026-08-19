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
	private firstEnqueueAt: number | null = null;
	private readonly deliver: (text: string) => void;
	private readonly debounceMs: number;
	private readonly maxDelayMs: number;

	/**
	 * @param deliver Called once per merged batch with the final text.
	 * @param debounceMs Quiet window before delivery; each new event resets it.
	 * @param maxDelayMs Upper bound from first enqueue to delivery — without it a
	 * steady event stream would starve delivery forever.
	 */
	constructor(deliver: (text: string) => void, debounceMs = 3000, maxDelayMs = 15000) {
		this.deliver = deliver;
		this.debounceMs = debounceMs;
		this.maxDelayMs = maxDelayMs;
	}

	/** Queue a message part; delivers after the debounce window goes quiet. */
	push(text: string): void {
		this.pending.push(text);
		const now = Date.now();
		if (this.firstEnqueueAt === null) this.firstEnqueueAt = now;
		if (now - this.firstEnqueueAt >= this.maxDelayMs) {
			this.flush();
			return;
		}
		if (this.timer) clearTimeout(this.timer);
		// Never schedule beyond the max-delay deadline either.
		const wait = Math.min(this.debounceMs, this.firstEnqueueAt + this.maxDelayMs - now);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, wait);
	}

	/** Deliver any queued parts now (no-op when empty). */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const parts = this.pending.splice(0);
		this.firstEnqueueAt = null;
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
		this.firstEnqueueAt = null;
	}

	get pendingCount(): number {
		return this.pending.length;
	}
}
