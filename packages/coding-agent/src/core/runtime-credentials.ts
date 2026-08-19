import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		// When a runtime override is set, apply the mutation to it so modify stays
		// consistent with read() (which prefers the override).
		if (this.overrides.has(providerId)) {
			const current: Credential = {
				type: "api_key",
				key: this.overrides.get(providerId) as string,
			};
			return fn(current).then((next) => {
				if (next && next.type === "api_key" && next.key) {
					this.overrides.set(providerId, next.key);
					return { type: "api_key" as const, key: next.key } satisfies Credential;
				}
				// The mutation removed/replaced the api_key credential: drop the
				// override and, if a non-api_key credential remains, persist it.
				this.overrides.delete(providerId);
				if (next) {
					return this.store.modify(providerId, () => Promise.resolve(next), options);
				}
				return next;
			});
		}
		return this.store.modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		// Capture the override fingerprint so a concurrently-set runtime key is not
		// clobbered by this delete.
		const override = this.overrides.get(providerId);
		await this.store.delete(providerId, options);
		if (override !== undefined && this.overrides.get(providerId) === override) {
			this.overrides.delete(providerId);
		}
	}
}
