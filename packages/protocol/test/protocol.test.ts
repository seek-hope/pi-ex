import { describe, expect, test } from "vitest";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	commandLeaseRole,
	decodeCbor,
	encodeCbor,
	encodeClientMessage,
	encodeFrame,
	encodeServerMessage,
	FrameDecoder,
	type InteractionRequest,
	isSharedAllowedCommand,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
	type ServerSnapshot,
	type SessionSnapshot,
} from "../src/index.ts";

const emptyServerSnapshot: ServerSnapshot = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_VERSION,
	revision: 0,
	sessions: [],
	models: [],
};

const clientHello: ClientHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
};

const serverHello: ServerHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
	connectionId: "connection-1",
	snapshot: emptyServerSnapshot,
};

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		id: "session-1",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 1,
		phase: "idle",
		model: { provider: "test", id: "model" },
		scopedModels: [],
		thinkingLevel: "medium",
		attached: true,
		locked: false,
		revision: 0,
		eventCursor: 0,
		lease: { exclusiveControllerConnected: true, observerCount: 0, mode: "exclusive" },
		transcript: [],
		queuedSteer: [],
		queuedSteerCount: 0,
		queuedFollowUp: [],
		queuedFollowUpCount: 0,
		steeringMode: "all",
		followUpMode: "all",
		surface: {},
		pendingInteractions: [],
		...overrides,
	};
}

function itemMessage(item: unknown, type: "item_started" | "item_updated" | "item_finished" = "item_finished") {
	return {
		type: "event",
		event: {
			type: "session_progress",
			eventCursor: 1,
			sessionId: "session-1",
			progress: { type, item },
		},
	};
}

describe("protocol validation", () => {
	test("uses protocol version 2", () => {
		expect(PROTOCOL_VERSION).toBe(2);
		expect(isSupportedProtocolVersion(2)).toBe(true);
		expect(isSupportedProtocolVersion(1)).toBe(false);
		expect(isSupportedProtocolVersion(3)).toBe(false);
		expect(isSupportedProtocolVersion(2.5)).toBe(false);
	});

	test.each([0, PROTOCOL_VERSION, PROTOCOL_VERSION + 1])(
		"accepts integer client hello version %s for negotiation",
		(version) => {
			const message = { ...clientHello, version };
			expect(parseClientMessage(message)).toEqual(message);
		},
	);

	test.each([
		["string version", { type: "hello", version: String(PROTOCOL_VERSION) }],
		["fractional version", { type: "hello", version: PROTOCOL_VERSION + 0.5 }],
		["credential field", { type: "hello", version: PROTOCOL_VERSION, token: "secret" }],
		["unknown field", { type: "hello", version: PROTOCOL_VERSION, extra: true }],
	] as const)("rejects a handshake with %s", (_label, message) => {
		expect(() => parseClientMessage(message)).toThrow(ProtocolValidationError);
	});

	test("does not parse JSON strings as wire messages", () => {
		expect(() => parseClientMessage(JSON.stringify(clientHello))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(JSON.stringify(serverHello))).toThrow(ProtocolValidationError);
	});

	test("rejects a text-only prompt frame (v2 requires structured content)", () => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "prompt", sessionId: "session-1", text: "inspect" },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("parses a server handshake snapshot", () => {
		expect(parseServerMessage(serverHello)).toEqual(serverHello);
	});

	test("represents listed sessions as durable metadata", () => {
		const message = {
			type: "response",
			id: "request-1",
			ok: true,
			result: {
				command: "list",
				sessions: [
					{
						id: "session-1",
						createdAt: 1,
						updatedAt: 2,
						parentSessionId: "parent-1",
						sessionName: "Named session",
						cwd: "/workspace",
					},
				],
			},
		} as const;

		expect(parseServerMessage(message)).toEqual(message);
		expect(() =>
			parseServerMessage({
				...message,
				result: {
					...message.result,
					sessions: [{ id: "session-1", createdAt: 1, phase: "idle" }],
				},
			}),
		).toThrow(ProtocolValidationError);
	});

	test.each([
		"not_implemented",
		"internal_error",
		"unauthorized",
		"interaction_timeout",
		"payload_too_large",
	] as const)("accepts the %s error code", (code) => {
		const message: ServerMessage = {
			type: "response",
			id: "request-1",
			ok: false,
			error: { code, message: "safe" },
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		{
			type: "hello",
			version: PROTOCOL_VERSION + 1,
			connectionId: "connection-1",
			snapshot: emptyServerSnapshot,
		},
		{ type: "hello_error", error: { code: "auth", message: "Authentication failed" } },
		{ type: "response", id: "request-1", ok: true, result: { command: "unknown" } },
		{ type: "event", event: { type: "session_removed", sessionId: 42 } },
	])("rejects invalid server messages", (wire) => {
		expect(() => parseServerMessage(wire)).toThrow(ProtocolValidationError);
	});

	test("validates nested JSON tool details", () => {
		const message = {
			type: "event",
			event: {
				type: "session_progress",
				eventCursor: 1,
				sessionId: "session-1",
				progress: {
					type: "item_finished",
					item: {
						id: "tool-1",
						role: "tool",
						toolCallId: "call-1",
						toolName: "read",
						input: { path: "/tmp/file" },
						content: [{ type: "text", text: "done" }],
						details: { lines: [1, 2, 3], cached: false },
						status: "complete",
						isError: false,
						timestamp: 1,
					},
				},
			},
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		{ status: "streaming" },
		{ status: "complete", stopReason: "stop" },
		{ status: "error", stopReason: "error" },
		{ status: "error", stopReason: "error", errorMessage: "failed" },
		{ status: "aborted", stopReason: "aborted" },
	])("accepts a consistent $status assistant item", (state) => {
		const message = itemMessage(
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				model: { provider: "test", id: "model" },
				timestamp: 1,
				...state,
			},
			state.status === "streaming" ? "item_updated" : "item_finished",
		);
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		{ status: "streaming", stopReason: "stop" },
		{ status: "complete" },
		{ status: "complete", stopReason: "error" },
		{ status: "error", stopReason: "error", errorMessage: "" },
		{ status: "aborted", stopReason: "stop" },
	])("rejects an inconsistent $status assistant item", (state) => {
		expect(() =>
			parseServerMessage(
				itemMessage({
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					model: { provider: "test", id: "model" },
					timestamp: 1,
					...state,
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	test.each([
		{ status: "running", isError: false },
		{ status: "complete", isError: false },
		{ status: "error", isError: true },
	])("accepts a consistent $status tool item", (state) => {
		const message = itemMessage(
			{
				id: "tool-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "read",
				input: {},
				content: [],
				timestamp: 1,
				...state,
			},
			state.status === "running" ? "item_updated" : "item_finished",
		);
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects nonterminal items reported as finished", () => {
		const assistant = {
			id: "assistant-1",
			role: "assistant",
			content: [],
			model: { provider: "test", id: "model" },
			status: "streaming",
			timestamp: 1,
		};
		const tool = {
			id: "tool-1",
			role: "tool",
			toolCallId: "call-1",
			toolName: "read",
			input: {},
			content: [],
			status: "running",
			isError: false,
			timestamp: 1,
		};

		expect(() => parseServerMessage(itemMessage(assistant))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(itemMessage(tool))).toThrow(ProtocolValidationError);
	});

	test.each([
		{ status: "running", isError: true },
		{ status: "complete", isError: true },
		{ status: "error", isError: false },
	])("rejects an inconsistent $status tool item", (state) => {
		expect(() =>
			parseServerMessage(
				itemMessage({
					id: "tool-1",
					role: "tool",
					toolCallId: "call-1",
					toolName: "read",
					input: {},
					content: [],
					timestamp: 1,
					...state,
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	test.each<{
		role: "bash";
		command: string;
		output: string;
		exitCode: number;
		timestamp: number;
		cancelled?: boolean;
		truncated?: boolean;
	}>([
		{ role: "bash", command: "ls", output: "a\nb\n", exitCode: 0, timestamp: 1 },
		{ role: "bash", command: "ls", output: "", exitCode: 0, cancelled: true, timestamp: 2 },
		{ role: "bash", command: "cat big", output: "truncated…", exitCode: 2, truncated: true, timestamp: 3 },
	])("accepts a bash transcript item $command", (item) => {
		const message = {
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot({ transcript: [{ id: "bash-1", ...item }] }),
			},
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		{ role: "bash", command: "ls", output: "a", timestamp: 1 },
		{ role: "bash", command: "ls", output: "a", exitCode: "0", timestamp: 1 },
		{ role: "bash", command: "ls", output: "a", exitCode: 0, extra: true, timestamp: 1 },
		{ role: "shell", command: "ls", output: "a", exitCode: 0, timestamp: 1 },
	])("rejects an inconsistent bash transcript item %j", (item) => {
		expect(() =>
			parseServerMessage({
				type: "event",
				event: {
					type: "session_snapshot",
					snapshot: sessionSnapshot({ transcript: [{ id: "bash-1", ...item } as never] }),
				},
			}),
		).toThrow(ProtocolValidationError);
	});

	test("accepts assistant_delta progress with text, thinking, and toolCall kinds", () => {
		for (const kind of ["text", "thinking", "toolCall"] as const) {
			const message = {
				type: "event",
				event: {
					type: "session_progress",
					eventCursor: 1,
					sessionId: "session-1",
					progress: { type: "assistant_delta", messageId: "m-1", contentIndex: 0, kind, delta: "chunk" },
				},
			};
			expect(parseServerMessage(message)).toEqual(message);
		}
	});

	test("accepts item_started with a streaming assistant item", () => {
		const message = itemMessage(
			{
				id: "live-assistant-1",
				role: "assistant",
				content: [],
				model: { provider: "test", id: "model" },
				status: "streaming",
				timestamp: 1,
			},
			"item_started",
		);
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects cyclic protocol values with a protocol validation error", () => {
		const details: Record<string, unknown> = {};
		details.self = details;
		const message = {
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "invalid_request", message: "invalid", details },
		};

		expect(() => parseServerMessage(message)).toThrow(ProtocolValidationError);
	});

	test("validation errors do not retain rejected payloads", () => {
		let thrown: unknown;
		try {
			parseClientMessage({
				type: "hello",
				version: String(PROTOCOL_VERSION),
				extra: "x".repeat(2_000_000),
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ProtocolValidationError);
		expect(Object.hasOwn(thrown as object, "value")).toBe(false);
		expect((thrown as Error).message.length).toBeLessThan(1_000);
	});
});

describe("session command lease classifier", () => {
	test("classifies shared reads, shared-allowed commands, and mutations", () => {
		for (const name of [
			"get_tree",
			"get_session_stats",
			"get_review_state",
			"get_available_models",
			"get_available_thinking_levels",
			"get_todos",
			"list_tasks",
			"get_task_output",
			"ssh_status",
			"get_subagents",
		] as const) {
			expect(commandLeaseRole(name)).toBe("read");
			expect(isSharedAllowedCommand(name)).toBe(true);
		}
		// resync/detach are shared-allowed but are not reads.
		for (const name of ["resync", "detach"] as const) {
			expect(isSharedAllowedCommand(name)).toBe(true);
			expect(commandLeaseRole(name)).toBe("mutation");
		}
		// Any other session command is a mutation (fail-closed).
		for (const name of ["set_name", "respond_interaction", "prompt", "navigate_tree", "cycle_thinking"] as const) {
			expect(commandLeaseRole(name)).toBe("mutation");
			expect(isSharedAllowedCommand(name)).toBe(false);
		}
	});

	test("classifies connection-scoped commands as free", () => {
		for (const name of [
			"list",
			"create",
			"attach",
			"get_settings",
			"set_setting",
			"login",
			"logout",
			"import_session",
		] as const) {
			expect(commandLeaseRole(name)).toBe("free");
		}
	});
});

describe("lease mode", () => {
	test("accepts create with an explicit exclusive lease", () => {
		expect(
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "create", leaseMode: "exclusive", cwd: "/w" },
			}),
		).toEqual({
			type: "request",
			id: "request-1",
			request: { command: "create", leaseMode: "exclusive", cwd: "/w" },
		});
	});

	test("accepts attach with a shared lease", () => {
		expect(
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "attach", sessionId: "session-1", leaseMode: "shared" },
			}),
		).toEqual({
			type: "request",
			id: "request-1",
			request: { command: "attach", sessionId: "session-1", leaseMode: "shared" },
		});
	});

	test.each([
		["create without leaseMode", { command: "create", cwd: "/w" }],
		["create with invalid leaseMode", { command: "create", leaseMode: "observer", cwd: "/w" }],
		["attach without leaseMode", { command: "attach", sessionId: "session-1" }],
		["attach with invalid leaseMode", { command: "attach", sessionId: "session-1", leaseMode: "exclusive-only" }],
	])("rejects %s", (_label, request) => {
		expect(() => parseClientMessage({ type: "request", id: "request-1", request })).toThrow(ProtocolValidationError);
	});

	test("session snapshot carries a lease projection", () => {
		const message = {
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot() },
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects a session snapshot missing its lease projection", () => {
		const snapshot = sessionSnapshot();
		delete (snapshot as Record<string, unknown>).lease;
		expect(() => parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toThrow(
			ProtocolValidationError,
		);
	});

	test("lease projection exposes this connection's mode, including null for lease-less observers", () => {
		for (const mode of ["exclusive", "shared", null] as const) {
			const snapshot = sessionSnapshot({ lease: { exclusiveControllerConnected: true, observerCount: 1, mode } });
			expect(parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toBeDefined();
		}
	});

	test("rejects a lease projection without a mode", () => {
		const snapshot = sessionSnapshot();
		delete (snapshot.lease as { mode?: string }).mode;
		expect(() => parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toThrow(
			ProtocolValidationError,
		);
	});
});

describe("event cursor", () => {
	function progressAt(cursor: unknown) {
		return {
			type: "event",
			event: {
				type: "session_progress",
				eventCursor: cursor,
				sessionId: "session-1",
				progress: {
					type: "item_finished",
					item: {
						id: "tool-1",
						role: "tool",
						toolCallId: "call-1",
						toolName: "read",
						input: {},
						content: [],
						status: "complete",
						isError: false,
						timestamp: 1,
					},
				},
			},
		};
	}

	test("accepts a zero and positive safe-integer cursor", () => {
		expect(parseServerMessage(progressAt(0))).toEqual(progressAt(0));
		expect(parseServerMessage(progressAt(Number.MAX_SAFE_INTEGER))).toEqual(progressAt(Number.MAX_SAFE_INTEGER));
	});

	test.each([
		["negative", -1],
		["fractional", 0.5],
		["string", "1"],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
	])("rejects a %s cursor", (_label, cursor) => {
		expect(() => parseServerMessage(progressAt(cursor))).toThrow(ProtocolValidationError);
	});

	test("rejects session_progress without an eventCursor", () => {
		expect(() =>
			parseServerMessage({
				type: "event",
				event: {
					type: "session_progress",
					sessionId: "session-1",
					progress: { type: "item_finished", item: {} },
				},
			}),
		).toThrow(ProtocolValidationError);
	});

	test("session snapshot carries an eventCursor", () => {
		expect(() =>
			parseServerMessage({
				type: "event",
				event: { type: "session_snapshot", snapshot: sessionSnapshot({ eventCursor: 7 }) },
			}),
		).not.toThrow();
	});
});

describe("interactions", () => {
	const selectRequest: InteractionRequest = {
		method: "select",
		id: "interaction-1",
		title: "Pick one",
		options: ["a", "b"],
	};
	const confirmRequest: InteractionRequest = {
		method: "confirm",
		id: "interaction-1",
		title: "Proceed?",
		message: "yes or no",
	};
	const inputRequest: InteractionRequest = {
		method: "input",
		id: "interaction-1",
		title: "Value",
		placeholder: "…",
		masked: true,
	};
	const editorRequest: InteractionRequest = {
		method: "editor",
		id: "interaction-1",
		title: "Edit",
		prefill: "draft",
	};

	function interactionEvent(request: unknown, cursor = 1) {
		return {
			type: "event",
			event: { type: "interaction_request", eventCursor: cursor, sessionId: "session-1", request },
		};
	}

	test.each([[selectRequest], [confirmRequest], [inputRequest], [editorRequest]])(
		"accepts each blocking interaction request variant",
		(request) => {
			expect(parseServerMessage(interactionEvent(request))).toEqual(interactionEvent(request));
		},
	);

	test.each([
		["select", { ...selectRequest, timeoutMs: 1000 }],
		["confirm", { ...confirmRequest, timeoutMs: 500 }],
		["input", { ...inputRequest, timeoutMs: 0 }],
		["editor", { ...editorRequest, timeoutMs: Number.MAX_SAFE_INTEGER }],
	])("accepts timeoutMs on %s", (_method, request) => {
		expect(parseServerMessage(interactionEvent(request))).toEqual(interactionEvent(request));
	});

	test.each([
		["negative", { ...selectRequest, timeoutMs: -1 }],
		["fractional", { ...selectRequest, timeoutMs: 1.5 }],
		["string", { ...selectRequest, timeoutMs: "1000" }],
		["unsafe integer", { ...selectRequest, timeoutMs: Number.MAX_SAFE_INTEGER + 1 }],
	])("rejects a %s timeoutMs", (_label, request) => {
		expect(() => parseServerMessage(interactionEvent(request))).toThrow(ProtocolValidationError);
	});

	test.each([
		["select empty options", { method: "select", id: "i", title: "t", options: [] }],
		["select missing options", { method: "select", id: "i", title: "t" }],
		["empty interaction id", { method: "select", id: "", title: "t", options: ["a"] }],
		["missing interaction id", { method: "select", title: "t", options: ["a"] }],
		["unknown method", { type: "sound", id: "i", title: "t" }],
		["unknown field on select", { method: "select", id: "i", title: "t", options: ["a"], extra: 1 }],
	])("rejects %s", (_label, request) => {
		expect(() => parseServerMessage(interactionEvent(request))).toThrow(ProtocolValidationError);
	});

	test("rejects an interaction_request without a cursor", () => {
		expect(() =>
			parseServerMessage({
				type: "event",
				event: { type: "interaction_request", sessionId: "session-1", request: selectRequest },
			}),
		).toThrow(ProtocolValidationError);
	});

	function respond(result: unknown) {
		const message = parseClientMessage({
			type: "request",
			id: "request-1",
			request: {
				command: "respond_interaction",
				sessionId: "session-1",
				interactionId: "interaction-1",
				result,
			},
		});
		if (message.type !== "request") throw new Error("unexpected hello");
		return message;
	}

	test("accepts confirm value true and false and cancellation as distinct replies", () => {
		expect(respond({ method: "confirm", kind: "value", value: true })).toBeDefined();
		expect(respond({ method: "confirm", kind: "value", value: false })).toBeDefined();
		expect(respond({ method: "confirm", kind: "cancelled" })).toBeDefined();
	});

	test("does not collapse confirm false into cancellation", () => {
		// false is a boolean value; cancelling is its own kind — a boolean field must not round-trip as cancelled.
		const reply = { method: "confirm", kind: "value", value: false } as const;
		expect(respond(reply).request).toMatchObject({ result: { kind: "value", value: false } });
		expect(respond({ method: "confirm", kind: "cancelled" }).request).not.toHaveProperty("result.value");
	});

	test.each([
		["select value", { method: "select", kind: "value", value: "a" }],
		["select cancelled", { method: "select", kind: "cancelled" }],
		["input value", { method: "input", kind: "value", value: "text" }],
		["input cancelled", { method: "input", kind: "cancelled" }],
		["editor value", { method: "editor", kind: "value", value: "edited" }],
		["editor cancelled", { method: "editor", kind: "cancelled" }],
	])("accepts %s reply", (_label, result) => {
		expect(respond(result)).toBeDefined();
	});

	test.each([
		["select with boolean value", { method: "select", kind: "value", value: true }],
		["confirm with string value", { method: "confirm", kind: "value", value: "yes" }],
		["confirm cancelled carrying value", { method: "confirm", kind: "cancelled", value: false }],
		["input with boolean value", { method: "input", kind: "value", value: false }],
		["editor with boolean value", { method: "editor", kind: "value", value: true }],
		["unknown kind", { method: "select", kind: "skipped" }],
		["unknown method", { method: "frob", kind: "value", value: "x" }],
	])("rejects %s reply", (_label, result) => {
		expect(() => respond(result)).toThrow(ProtocolValidationError);
	});

	test("respond_interaction result reports accepted/settled/not_found status", () => {
		for (const status of ["accepted", "settled", "not_found"] as const) {
			const message = {
				type: "response",
				id: "request-1",
				ok: true,
				result: { command: "respond_interaction", status },
			};
			expect(parseServerMessage(message)).toEqual(message);
		}
		expect(() =>
			parseServerMessage({
				type: "response",
				id: "request-1",
				ok: true,
				result: { command: "respond_interaction", status: "success" },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("resync returns an authoritative session snapshot", () => {
		const command = parseClientMessage({
			type: "request",
			id: "request-1",
			request: { command: "resync", sessionId: "session-1" },
		});
		expect(command).toBeDefined();

		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "resync", session: sessionSnapshot({ eventCursor: 9 }) },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("snapshot carries pending blocking interactions", () => {
		const snapshot = sessionSnapshot({ pendingInteractions: [selectRequest] });
		expect(parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toBeDefined();
	});
});

describe("structured content and blob references", () => {
	const blob = { id: "blob-1", token: "tok-1", size: 1234 } as const;

	test("accepts structured text+image prompt content", () => {
		const request = {
			command: "prompt",
			sessionId: "session-1",
			content: [
				{ type: "text", text: "inspect" },
				{ type: "image", blob },
			],
		};
		expect(parseClientMessage({ type: "request", id: "request-1", request })).toBeDefined();
	});

	test("accepts steer and follow_up structured content", () => {
		for (const command of ["steer", "follow_up"] as const) {
			const request = { command, sessionId: "session-1", content: [{ type: "text", text: "hi" }] };
			expect(parseClientMessage({ type: "request", id: "request-1", request })).toBeDefined();
		}
	});

	test.each([
		["empty blob id", { id: "", token: "t", size: 1 }],
		["empty blob token", { id: "i", token: "", size: 1 }],
		["missing blob size", { id: "i", token: "t" }],
		["negative blob size", { id: "i", token: "t", size: -1 }],
		["fractional blob size", { id: "i", token: "t", size: 1.5 }],
		["unsafe blob size", { id: "i", token: "t", size: Number.MAX_SAFE_INTEGER + 1 }],
		["unknown blob field", { id: "i", token: "t", size: 1, mime: "image/png" }],
	])("rejects a blob reference with %s", (_label, badBlob) => {
		const request = { command: "prompt", sessionId: "s", content: [{ type: "image", blob: badBlob }] };
		expect(() => parseClientMessage({ type: "request", id: "r", request })).toThrow(ProtocolValidationError);
	});

	test("accepts optional blob mediaType and name", () => {
		const request = {
			command: "prompt",
			sessionId: "s",
			content: [{ type: "image", blob: { id: "i", token: "t", size: 1, mediaType: "image/png", name: "a.png" } }],
		};
		expect(parseClientMessage({ type: "request", id: "r", request })).toBeDefined();
	});

	test("rejects unknown content part kinds", () => {
		const request = { command: "prompt", sessionId: "s", content: [{ type: "audio", url: "x" }] };
		expect(() => parseClientMessage({ type: "request", id: "r", request })).toThrow(ProtocolValidationError);
	});
});

describe("surface updates", () => {
	function surfaceEvent(operation: unknown, cursor = 1) {
		return {
			type: "event",
			event: { type: "surface_update", eventCursor: cursor, sessionId: "session-1", operation },
		};
	}

	test.each([
		[{ op: "notify", message: "hello", kind: "info" }],
		[{ op: "notify", message: "hello", kind: "warning" }],
		[{ op: "notify", message: "hello" }],
		[{ op: "set_status", key: "status", text: "Working" }],
		[{ op: "set_status", key: "status", text: null }],
		[{ op: "set_working_message", message: "Thinking…" }],
		[{ op: "set_working_message", message: null }],
		[{ op: "set_working_visible", visible: true }],
		[{ op: "set_working_indicator", indicator: { frames: ["|", "/", "-", "\\"], intervalMs: 100 } }],
		[{ op: "set_working_indicator", indicator: { frames: ["…"] } }],
		[{ op: "set_working_indicator", indicator: null }],
		[{ op: "set_hidden_thinking_label", label: "secret" }],
		[{ op: "set_widget", key: "w", lines: ["a", "b"] }],
		[{ op: "set_widget", key: "w", lines: ["a", "b"], placement: "aboveEditor" }],
		[{ op: "set_widget", key: "w", lines: ["a", "b"], placement: "belowEditor" }],
		[{ op: "set_widget", key: "w", lines: null }],
		[{ op: "set_title", title: "Title" }],
		[{ op: "set_editor_text", text: "draft" }],
		[{ op: "set_theme", theme: "dark" }],
		[{ op: "set_tools_expanded", expanded: false }],
	])("accepts surface operation %o", (operation) => {
		expect(parseServerMessage(surfaceEvent(operation))).toEqual(surfaceEvent(operation));
	});

	test.each([
		["unknown op", { op: "flash" }],
		["notify missing message", { op: "notify" }],
		["notify unknown kind", { op: "notify", message: "m", kind: "loud" }],
		["notify legacy notifyType field", { op: "notify", message: "m", notifyType: "info" }],
		["set_status unknown field", { op: "set_status", key: "s", text: "x", extra: 1 }],
		["set_widget bad placement", { op: "set_widget", key: "w", lines: ["a"], placement: "sidebar" }],
		["set_working_indicator string", { op: "set_working_indicator", indicator: "spinner" }],
		["set_working_indicator negative interval", { op: "set_working_indicator", indicator: { intervalMs: -1 } }],
		["set_working_visible with string", { op: "set_working_visible", visible: "yes" }],
		["set_tools_expanded with string", { op: "set_tools_expanded", expanded: "yes" }],
	])("rejects %s", (_label, operation) => {
		expect(() => parseServerMessage(surfaceEvent(operation))).toThrow(ProtocolValidationError);
	});

	test("rejects surface_update without a cursor", () => {
		expect(() =>
			parseServerMessage({
				type: "event",
				event: { type: "surface_update", sessionId: "session-1", operation: { op: "notify", message: "m" } },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("snapshot carries a reconstructable surface state", () => {
		const snapshot = sessionSnapshot({
			surface: {
				statuses: { status: "Working", build: "ok" },
				workingMessage: "Thinking…",
				workingVisible: true,
				workingIndicator: { frames: ["|", "/"], intervalMs: 120 },
				widgets: { w: { lines: ["line"], placement: "aboveEditor" } },
				title: "T",
				editorText: "draft",
				theme: "dark",
				toolsExpanded: true,
			},
		});
		expect(parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toBeDefined();
	});
});

describe("commands and results (parity inventory)", () => {
	function request(command: unknown) {
		return { type: "request", id: "request-1", request: command };
	}
	function ok(result: unknown) {
		return { type: "response", id: "request-1", ok: true, result };
	}

	test("accepts the full command inventory", () => {
		const commands: unknown[] = [
			{ command: "list" },
			{ command: "create", leaseMode: "exclusive", cwd: "/w" },
			{ command: "attach", sessionId: "s", leaseMode: "exclusive" },
			{ command: "detach", sessionId: "s" },
			{ command: "prompt", sessionId: "s", content: [{ type: "text", text: "hi" }] },
			{ command: "steer", sessionId: "s", content: [{ type: "text", text: "hi" }] },
			{ command: "follow_up", sessionId: "s", content: [{ type: "text", text: "hi" }] },
			{ command: "clear_queue", sessionId: "s" },
			{ command: "set_queue_mode", sessionId: "s", queue: "steer", mode: "all" },
			{ command: "set_queue_mode", sessionId: "s", queue: "follow_up", mode: "one-at-a-time" },
			{ command: "abort", sessionId: "s" },
			{ command: "get_tree", sessionId: "s" },
			{ command: "navigate_tree", sessionId: "s", targetId: "e" },
			{ command: "navigate_tree", sessionId: "s", targetId: "e", summarize: true, label: "L" },
			{
				command: "navigate_tree",
				sessionId: "s",
				targetId: "e",
				customInstructions: "be brief",
				replaceInstructions: true,
			},
			{ command: "get_session_stats", sessionId: "s" },
			{ command: "set_name", sessionId: "s", name: "N" },
			{ command: "fork", sessionId: "s", entryId: "e" },
			{ command: "clone", sessionId: "s" },
			{ command: "compact", sessionId: "s" },
			{ command: "set_auto_compaction", sessionId: "s", enabled: true },
			{ command: "abort_compaction", sessionId: "s" },
			{ command: "get_review_state", sessionId: "s" },
			{ command: "respond_review", sessionId: "s", reviewId: "r", decision: { kind: "approve" } },
			{ command: "get_available_models", sessionId: "s" },
			{ command: "set_model", sessionId: "s", model: { provider: "p", id: "m" } },
			{ command: "cycle_model", sessionId: "s" },
			{ command: "cycle_model", sessionId: "s", direction: "forward" },
			{ command: "cycle_model", sessionId: "s", direction: "backward" },
			{ command: "set_scoped_models", sessionId: "s", models: [{ provider: "p", id: "m" }] },
			{ command: "set_thinking", sessionId: "s", thinkingLevel: "high" },
			{ command: "cycle_thinking", sessionId: "s" },
			{ command: "get_available_thinking_levels", sessionId: "s" },
			{ command: "get_settings" },
			{ command: "set_setting", key: "k", value: { nested: true } },
			{ command: "login", provider: "anthropic" },
			{ command: "logout", provider: "anthropic" },
			{ command: "set_trust", sessionId: "s", cwd: "/w", trusted: true, persist: false },
			{ command: "reload", sessionId: "s" },
			{ command: "bash", sessionId: "s", commandLine: "ls" },
			{ command: "abort_bash", sessionId: "s" },
			{ command: "get_todos", sessionId: "s" },
			{ command: "list_tasks", sessionId: "s" },
			{ command: "get_task_output", sessionId: "s", taskId: "t" },
			{ command: "kill_task", sessionId: "s", taskId: "t" },
			{ command: "attach_task", sessionId: "s", taskId: "t" },
			{ command: "ssh_status", sessionId: "s" },
			{ command: "ssh_connect", sessionId: "s", host: "user@host" },
			{ command: "ssh_command", sessionId: "s", host: "user@host", remoteCommand: "ls" },
			{ command: "ssh_sudo", sessionId: "s", host: "user@host" },
			{ command: "ssh_close", sessionId: "s", host: "user@host" },
			{ command: "get_subagents", sessionId: "s" },
			{ command: "import_session", blob: { id: "b", token: "t", size: 1 } },
			{ command: "export_session", sessionId: "s", format: "html" },
			{ command: "share_as_gist", sessionId: "s" },
			{
				command: "respond_interaction",
				sessionId: "s",
				interactionId: "i",
				result: { method: "confirm", kind: "value", value: true },
			},
			{ command: "resync", sessionId: "s" },
		];
		for (const command of commands) {
			expect(parseClientMessage(request(command))).toBeDefined();
		}
	});

	test("get_tree result round-trips a recursive tree", () => {
		const result = {
			command: "get_tree",
			tree: [
				{
					entry: {
						type: "message",
						id: "e1",
						parentId: null,
						timestamp: "2026-08-15T09:00:00.000Z",
						message: { role: "user", text: "hi" },
					},
					children: [
						{
							entry: {
								type: "label",
								id: "e2",
								parentId: "e1",
								timestamp: "2026-08-15T09:00:01.000Z",
								targetId: "e1",
								label: null,
							},
							children: [],
							label: "root",
							labelTimestamp: "2026-08-15T09:00:02.000Z",
						},
					],
					label: "root",
				},
			],
			leafId: "e2",
		};
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("navigate_tree result projects a no-op navigation (already at target)", () => {
		const result = { command: "navigate_tree", session: sessionSnapshot(), cancelled: false };
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("navigate_tree result projects a cancelled navigation (hook/extension cancel)", () => {
		const result = { command: "navigate_tree", session: sessionSnapshot(), cancelled: true };
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("navigate_tree result projects an aborted summary", () => {
		const result = { command: "navigate_tree", session: sessionSnapshot(), cancelled: true, aborted: true };
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("navigate_tree result projects editor text, a summary entry, and a file revert", () => {
		const result = {
			command: "navigate_tree",
			session: sessionSnapshot(),
			cancelled: false,
			editorText: "rewound prompt",
			summaryEntry: {
				type: "branch_summary",
				id: "summary-1",
				parentId: "e1",
				timestamp: "2026-08-15T09:00:03.000Z",
				fromId: "e2",
				summary: "context so far",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			fileRevert: { reverted: ["a.ts"], skipped: ["b.ts"] },
		};
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("navigate_tree result preserves /tree rewind skipped-file reporting", () => {
		const result = {
			command: "navigate_tree",
			session: sessionSnapshot(),
			cancelled: false,
			fileRevert: { reverted: [], skipped: ["b.ts"] },
		};
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("navigate_tree rejects a missing cancelled projection or the legacy rewind shape", () => {
		expect(() => parseServerMessage(ok({ command: "navigate_tree", session: sessionSnapshot() }))).toThrow(
			ProtocolValidationError,
		);
		expect(() =>
			parseServerMessage(
				ok({
					command: "navigate_tree",
					session: sessionSnapshot(),
					cancel: true,
					rewind: { revertedFiles: [], skippedFiles: [] },
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	test("cycle_model result carries the authoritative session and a typed cycle outcome", () => {
		const cycled = {
			command: "cycle_model",
			session: sessionSnapshot(),
			cycle: { model: { provider: "test", id: "model-2" }, thinkingLevel: "high", isScoped: true },
		};
		expect(parseServerMessage(ok(cycled))).toEqual(ok(cycled));

		const noCycle = { command: "cycle_model", session: sessionSnapshot(), cycle: null };
		expect(parseServerMessage(ok(noCycle))).toEqual(ok(noCycle));
	});

	test("cycle_thinking result carries the authoritative session and an explicit thinking level", () => {
		const cycled = { command: "cycle_thinking", session: sessionSnapshot(), thinkingLevel: "low" };
		expect(parseServerMessage(ok(cycled))).toEqual(ok(cycled));

		const noCycle = { command: "cycle_thinking", session: sessionSnapshot(), thinkingLevel: null };
		expect(parseServerMessage(ok(noCycle))).toEqual(ok(noCycle));
	});

	test("get_session_stats result is typed", () => {
		const result = {
			command: "get_session_stats",
			sessionId: "s",
			stats: {
				sessionId: "s",
				userMessages: 1,
				assistantMessages: 2,
				toolCalls: 3,
				toolResults: 4,
				totalMessages: 5,
				tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				cost: 0.01,
			},
		};
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("get_settings result carries an arbitrary JSON settings map", () => {
		const result = { command: "get_settings", settings: { theme: "dark", counts: [1, 2, 3] } };
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("task and subagent results use the coding-agent runtime status vocabulary", () => {
		const tasks = {
			command: "list_tasks",
			sessionId: "s",
			tasks: [{ id: "task-1", label: "check", status: "done", startedAt: 1, finishedAt: 2, exitCode: 0 }],
		};
		expect(parseServerMessage(ok(tasks))).toEqual(ok(tasks));

		const subagents = {
			command: "get_subagents",
			sessionId: "s",
			subagents: [{ id: "agent-1", worktree: "/tmp/agent-1", status: "interrupted" }],
		};
		expect(parseServerMessage(ok(subagents))).toEqual(ok(subagents));
	});

	test("export_session result carries a blob reference", () => {
		const result = { command: "export_session", blob: { id: "b", token: "t", size: 42, mediaType: "text/html" } };
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("share_as_gist result carries a URL", () => {
		const result = { command: "share_as_gist", url: "https://gist.github.com/x" };
		expect(parseServerMessage(ok(result))).toEqual(ok(result));
	});

	test("rejects cross-field command strictness violations", () => {
		expect(() =>
			parseClientMessage(request({ command: "set_queue_mode", sessionId: "s", queue: "steer", mode: "bogus" })),
		).toThrow(ProtocolValidationError);
		expect(() =>
			parseClientMessage(
				request({ command: "set_queue_mode", sessionId: "s", queue: "steer", mode: "one_at_a_time" }),
			),
		).toThrow(ProtocolValidationError);
		expect(() => parseClientMessage(request({ command: "bash", sessionId: "s", commandLine: "" }))).toThrow(
			ProtocolValidationError,
		);
		expect(() => parseClientMessage(request({ command: "export_session", sessionId: "s", format: "pdf" }))).toThrow(
			ProtocolValidationError,
		);
		expect(() =>
			parseClientMessage(
				request({ command: "respond_review", sessionId: "s", reviewId: "r", decision: { kind: "edit" } }),
			),
		).toThrow(ProtocolValidationError);
	});
});

describe("lease_lost and error events", () => {
	test("accepts lease_lost with revoked and demoted reasons", () => {
		for (const reason of ["revoked", "demoted"] as const) {
			const message = { type: "event", event: { type: "lease_lost", sessionId: "s", reason } };
			expect(parseServerMessage(message)).toEqual(message);
		}
	});

	test("rejects lease_lost with an unknown reason", () => {
		expect(() =>
			parseServerMessage({ type: "event", event: { type: "lease_lost", sessionId: "s", reason: "gone" } }),
		).toThrow(ProtocolValidationError);
	});

	test("accepts a connection-scoped error event", () => {
		const message = { type: "event", event: { type: "error", error: { code: "internal_error", message: "boom" } } };
		expect(parseServerMessage(message)).toEqual(message);
	});
});

describe("queue_update events", () => {
	test("accepts a cursor-bearing queue_update", () => {
		const message = {
			type: "event",
			event: {
				type: "queue_update",
				eventCursor: 3,
				sessionId: "s",
				queue: "follow_up",
				mode: "one-at-a-time",
				queuedCount: 2,
			},
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects queue_update missing a cursor", () => {
		expect(() =>
			parseServerMessage({
				type: "event",
				event: { type: "queue_update", sessionId: "s", queue: "steer", mode: "all", queuedCount: 0 },
			}),
		).toThrow(ProtocolValidationError);
	});
});

describe("validated framed protocol APIs", () => {
	test("encodes complete client and server frames", () => {
		const clientFrames = new FrameDecoder().push(encodeClientMessage(clientHello));
		expect(clientFrames).toHaveLength(1);
		expect(parseClientMessage(decodeCbor(clientFrames[0]!))).toEqual(clientHello);

		const serverFrames = new FrameDecoder().push(encodeServerMessage(serverHello));
		expect(serverFrames).toHaveLength(1);
		expect(parseServerMessage(decodeCbor(serverFrames[0]!))).toEqual(serverHello);
	});

	test("enforces an outbound frame limit before returning encoded bytes", () => {
		expect(() => encodeClientMessage(clientHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
		expect(() => encodeServerMessage(serverHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
	});

	test("validates messages before encoding", () => {
		expect(() => encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION + 0.5 })).toThrow(
			ProtocolValidationError,
		);
	});

	test("omits explicit undefined optional properties on the wire", () => {
		const message: ClientMessage = {
			type: "request",
			id: "request-1",
			request: { command: "create", leaseMode: "exclusive", cwd: undefined, name: undefined },
		};
		const [payload] = new FrameDecoder().push(encodeClientMessage(message));
		expect(decodeCbor(payload!)).toEqual({
			type: "request",
			id: "request-1",
			request: { command: "create", leaseMode: "exclusive" },
		});
	});

	test("incrementally decodes fragmented and coalesced client messages", () => {
		const request: ClientMessage = {
			type: "request",
			id: "request-1",
			request: { command: "list" },
		};
		const first = encodeClientMessage(clientHello);
		const second = encodeClientMessage(request);
		const wire = new Uint8Array(first.byteLength + second.byteLength);
		wire.set(first);
		wire.set(second, first.byteLength);

		for (let split = 0; split <= wire.byteLength; split++) {
			const decoder = new ClientMessageDecoder();
			const messages = [...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))];
			decoder.end();
			expect(messages).toEqual([clientHello, request]);
		}
	});

	test("incrementally decodes server messages", () => {
		const errorMessage: ServerMessage = {
			type: "hello_error",
			error: { code: "version", message: "Unsupported protocol version" },
		};
		const decoder = new ServerMessageDecoder();
		expect(decoder.push(encodeServerMessage(errorMessage))).toEqual([errorMessage]);
		decoder.end();
	});

	test("round-trips a full v2 session snapshot through fragmented framing", () => {
		const snapshot = sessionSnapshot({
			eventCursor: 4,
			surface: { statuses: { status: "Working" }, title: "T" },
			pendingInteractions: [{ method: "input", id: "i1", title: "sudo", masked: true }],
		});
		const event: ServerMessage = { type: "event", event: { type: "session_snapshot", snapshot } };
		const wire = encodeServerMessage(event);
		const decoder = new ServerMessageDecoder();
		const messages = [
			...decoder.push(wire.subarray(0, 3)),
			...decoder.push(wire.subarray(3, 13)),
			...decoder.push(wire.subarray(13)),
		];
		decoder.end();
		expect(messages).toEqual([event]);
	});

	test.each([
		["empty CBOR payload", encodeFrame(new Uint8Array())],
		["malformed CBOR", encodeFrame(new Uint8Array([0xff]))],
		["schema-invalid CBOR", encodeFrame(encodeCbor({ type: "hello", version: PROTOCOL_VERSION, extra: true }))],
	] as const)("rejects invalid framed client input: %s", (_label, wire) => {
		const decoder = new ClientMessageDecoder();
		expect(() => decoder.push(wire)).toThrow(ProtocolValidationError);
		expect(() => decoder.push(encodeClientMessage(clientHello))).toThrow(/failed/i);
	});

	test("rejects CBOR byte strings nested in JSON-valued fields", () => {
		const wire = encodeFrame(
			encodeCbor({
				type: "response",
				id: "request-1",
				ok: false,
				error: {
					code: "invalid_request",
					message: "invalid",
					details: { nested: new Uint8Array([1, 2, 3]) },
				},
			}),
		);
		expect(() => new ServerMessageDecoder().push(wire)).toThrow(ProtocolValidationError);
	});

	test("rejects truncated and oversized framing through the validated decoder", () => {
		const truncated = new ServerMessageDecoder();
		expect(truncated.push(new Uint8Array([0, 0, 0, 2, 1]))).toEqual([]);
		expect(() => truncated.end()).toThrow(ProtocolValidationError);

		const oversized = new ClientMessageDecoder({ maxFrameLength: 3 });
		expect(() => oversized.push(new Uint8Array([0, 0, 0, 4]))).toThrow(ProtocolValidationError);
	});
});
