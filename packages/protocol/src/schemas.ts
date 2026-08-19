import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 2 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
/** ISO-8601 timestamp string, matching session-manager/tree-entry timestamps. */
const TimestampStringSchema = Type.String({ minLength: 1 });
/** Nonnegative safe integer, used for per-session cursors and bounded sizes/counts. */
const NonnegativeSafeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */
export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const ModelRefSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
});
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});

export const ModelMetadataSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: Type.String({ minLength: 1 }),
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
	authenticated: Type.Boolean(),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	redacted: Type.Optional(Type.Boolean()),
});
export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
export const ToolCallContentSchema = StrictObject({
	type: Type.Literal("toolCall"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
});
export const UserContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export const AssistantContentSchema = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
export const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export type TextContent = Static<typeof TextContentSchema>;
export type ThinkingContent = Static<typeof ThinkingContentSchema>;
export type ImageContent = Static<typeof ImageContentSchema>;
export type ToolCallContent = Static<typeof ToolCallContentSchema>;

export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
	reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
	totalTokens: Type.Integer({ minimum: 0 }),
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});
export type Usage = Static<typeof UsageSchema>;

export const UserTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(UserContentSchema),
	timestamp: TimestampSchema,
});
const AssistantTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(AssistantContentSchema),
	model: ModelRefSchema,
	responseModel: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const StreamingAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("streaming"),
});
const CompleteAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("complete"),
	stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
});
const ErrorAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("error"),
	stopReason: Type.Literal("error"),
	errorMessage: Type.Optional(Type.String({ minLength: 1 })),
});
const AbortedAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("aborted"),
	stopReason: Type.Literal("aborted"),
	errorMessage: Type.Optional(Type.String()),
});
export const AssistantTranscriptItemSchema = Type.Union([
	StreamingAssistantTranscriptItemSchema,
	CompleteAssistantTranscriptItemSchema,
	ErrorAssistantTranscriptItemSchema,
	AbortedAssistantTranscriptItemSchema,
]);
const ToolTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
	content: Type.Array(ToolContentSchema),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const RunningToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("running"),
	isError: Type.Literal(false),
});
const CompleteToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("complete"),
	isError: Type.Literal(false),
});
const ErrorToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("error"),
	isError: Type.Literal(true),
});
export const ToolTranscriptItemSchema = Type.Union([
	RunningToolTranscriptItemSchema,
	CompleteToolTranscriptItemSchema,
	ErrorToolTranscriptItemSchema,
]);

/** A recorded shell execution (`bash` command), carried in the transcript as a dedicated item. */
export const BashTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("bash"),
	command: Type.String(),
	output: Type.String(),
	exitCode: Type.Integer(),
	cancelled: Type.Optional(Type.Boolean()),
	truncated: Type.Optional(Type.Boolean()),
	timestamp: TimestampSchema,
});
export type BashTranscriptItem = Static<typeof BashTranscriptItemSchema>;

export const TranscriptItemSchema = Type.Union([
	UserTranscriptItemSchema,
	AssistantTranscriptItemSchema,
	ToolTranscriptItemSchema,
	BashTranscriptItemSchema,
]);
export type UserTranscriptItem = Static<typeof UserTranscriptItemSchema>;
export type AssistantTranscriptItem = Static<typeof AssistantTranscriptItemSchema>;
export type ToolTranscriptItem = Static<typeof ToolTranscriptItemSchema>;
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** Normalized incremental activity. Snapshots remain authoritative. */
export const TranscriptProgressSchema = Type.Union([
	StrictObject({
		type: Type.Literal("item_started"),
		item: TranscriptItemSchema,
	}),
	StrictObject({
		type: Type.Literal("assistant_delta"),
		messageId: IdSchema,
		contentIndex: Type.Integer({ minimum: 0 }),
		kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("toolCall")]),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("item_updated"),
		item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
	}),
	StrictObject({
		type: Type.Literal("item_finished"),
		item: Type.Union([
			CompleteAssistantTranscriptItemSchema,
			ErrorAssistantTranscriptItemSchema,
			AbortedAssistantTranscriptItemSchema,
			CompleteToolTranscriptItemSchema,
			ErrorToolTranscriptItemSchema,
		]),
	}),
]);
export type TranscriptProgress = Static<typeof TranscriptProgressSchema>;

/**
 * A typed reference to a large blob staged out-of-band (HTTP in later phases).
 * Carries a non-empty `id` and `token`, optional `mediaType`/`name`, and a
 * bounded nonnegative `size` in bytes. The actual bytes never ride the CBOR
 * control channel.
 */
export const BlobReferenceSchema = StrictObject({
	id: IdSchema,
	token: IdSchema,
	mediaType: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String({ minLength: 1 })),
	size: NonnegativeSafeIntegerSchema,
});
export type BlobReference = Static<typeof BlobReferenceSchema>;

/** Structured prompt/steer/follow-up content: text and image parts. */
export const TextMessagePartSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
export const ImageMessagePartSchema = StrictObject({
	type: Type.Literal("image"),
	blob: BlobReferenceSchema,
});
export const MessagePartSchema = Type.Union([TextMessagePartSchema, ImageMessagePartSchema]);
export type TextMessagePart = Static<typeof TextMessagePartSchema>;
export type ImageMessagePart = Static<typeof ImageMessagePartSchema>;
export type MessagePart = Static<typeof MessagePartSchema>;

/** Connection lease mode declared on `create`/`attach`. */
export const LeaseModeSchema = Type.Union([Type.Literal("exclusive"), Type.Literal("shared")]);
export type LeaseMode = Static<typeof LeaseModeSchema>;

/** Authoritative projection of lease ownership carried in a session snapshot. */
export const SessionLeaseSchema = StrictObject({
	exclusiveControllerConnected: Type.Boolean(),
	observerCount: NonnegativeSafeIntegerSchema,
	/** This connection's lease mode, or null when it is not attached to the session. */
	mode: Type.Union([LeaseModeSchema, Type.Null()]),
});
export type SessionLease = Static<typeof SessionLeaseSchema>;

/** Where a text widget is rendered relative to the editor (`InteractionPort`). */
export const WidgetPlacementSchema = Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]);
export type WidgetPlacement = Static<typeof WidgetPlacementSchema>;

/** Configuration for a working indicator (e.g. spinner frames + cadence). */
export const WorkingIndicatorConfigSchema = StrictObject({
	frames: Type.Optional(Type.Array(Type.String())),
	intervalMs: Type.Optional(NonnegativeSafeIntegerSchema),
});
export type WorkingIndicatorConfig = Static<typeof WorkingIndicatorConfigSchema>;

/** Per-key string widget projection: rendered lines plus placement. */
export const WidgetLineSchema = Type.Array(Type.String());
export const WidgetStateSchema = StrictObject({
	lines: WidgetLineSchema,
	placement: WidgetPlacementSchema,
});
export type WidgetState = Static<typeof WidgetStateSchema>;

/**
 * Reconstructable nonblocking surface projection (statuses map, working
 * message/indicator, hidden thinking label, widgets, title, editor mirror,
 * theme id, tools-expanded). Carried in `SessionSnapshot` so a resync rebuilds
 * the full surface without replaying transient notifications.
 */
export const SurfaceStateSchema = StrictObject({
	statuses: Type.Optional(Type.Record(Type.String(), Type.String())),
	workingMessage: Type.Optional(Type.String()),
	workingVisible: Type.Optional(Type.Boolean()),
	workingIndicator: Type.Optional(WorkingIndicatorConfigSchema),
	hiddenThinkingLabel: Type.Optional(Type.String()),
	widgets: Type.Optional(Type.Record(Type.String(), WidgetStateSchema)),
	title: Type.Optional(Type.String()),
	editorText: Type.Optional(Type.String()),
	theme: Type.Optional(Type.String()),
	toolsExpanded: Type.Optional(Type.Boolean()),
});
export type SurfaceState = Static<typeof SurfaceStateSchema>;

// ---------------------------------------------------------------------------
// Interactions (blocking methods plus the matching reply union)
// ---------------------------------------------------------------------------

const InteractionRequestBaseProperties = {
	id: IdSchema,
} as const;

export const SelectInteractionRequestSchema = StrictObject({
	...InteractionRequestBaseProperties,
	method: Type.Literal("select"),
	title: Type.String({ minLength: 1 }),
	options: Type.Array(Type.String(), { minItems: 1 }),
	/** Timeout in milliseconds; when exceeded the server settles the interaction as `interaction_timeout`. */
	timeoutMs: Type.Optional(NonnegativeSafeIntegerSchema),
});
export const ConfirmInteractionRequestSchema = StrictObject({
	...InteractionRequestBaseProperties,
	method: Type.Literal("confirm"),
	title: Type.String({ minLength: 1 }),
	message: Type.String(),
	/** Timeout in milliseconds; when exceeded the server settles the interaction as `interaction_timeout`. */
	timeoutMs: Type.Optional(NonnegativeSafeIntegerSchema),
});
export const InputInteractionRequestSchema = StrictObject({
	...InteractionRequestBaseProperties,
	method: Type.Literal("input"),
	title: Type.String({ minLength: 1 }),
	placeholder: Type.Optional(Type.String()),
	masked: Type.Optional(Type.Boolean()),
	/** Timeout in milliseconds; when exceeded the server settles the interaction as `interaction_timeout`. */
	timeoutMs: Type.Optional(NonnegativeSafeIntegerSchema),
});
export const EditorInteractionRequestSchema = StrictObject({
	...InteractionRequestBaseProperties,
	method: Type.Literal("editor"),
	title: Type.String({ minLength: 1 }),
	prefill: Type.Optional(Type.String()),
	/** Timeout in milliseconds; when exceeded the server settles the interaction as `interaction_timeout`. */
	timeoutMs: Type.Optional(NonnegativeSafeIntegerSchema),
});
export const InteractionRequestSchema = Type.Union([
	SelectInteractionRequestSchema,
	ConfirmInteractionRequestSchema,
	InputInteractionRequestSchema,
	EditorInteractionRequestSchema,
]);
export type SelectInteractionRequest = Static<typeof SelectInteractionRequestSchema>;
export type ConfirmInteractionRequest = Static<typeof ConfirmInteractionRequestSchema>;
export type InputInteractionRequest = Static<typeof InputInteractionRequestSchema>;
export type EditorInteractionRequest = Static<typeof EditorInteractionRequestSchema>;
export type InteractionRequest = Static<typeof InteractionRequestSchema>;

/**
 * Reply to a pending interaction. The `method` discriminator ties the reply to
 * the pending method, and `confirm` preserves an explicit `false` (`value`)
 * from cancellation (`cancelled`) — two distinct outcomes that must not be
 * collapsed.
 */
export const InteractionResponseSchema = Type.Union([
	StrictObject({ method: Type.Literal("select"), kind: Type.Literal("value"), value: Type.String() }),
	StrictObject({ method: Type.Literal("select"), kind: Type.Literal("cancelled") }),
	StrictObject({ method: Type.Literal("confirm"), kind: Type.Literal("value"), value: Type.Boolean() }),
	StrictObject({ method: Type.Literal("confirm"), kind: Type.Literal("cancelled") }),
	StrictObject({ method: Type.Literal("input"), kind: Type.Literal("value"), value: Type.String() }),
	StrictObject({ method: Type.Literal("input"), kind: Type.Literal("cancelled") }),
	StrictObject({ method: Type.Literal("editor"), kind: Type.Literal("value"), value: Type.String() }),
	StrictObject({ method: Type.Literal("editor"), kind: Type.Literal("cancelled") }),
]);
export type InteractionResponse = Static<typeof InteractionResponseSchema>;

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

export const QueueKindSchema = Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]);
export type QueueKind = Static<typeof QueueKindSchema>;

export const QueueModeSchema = Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]);
export type QueueMode = Static<typeof QueueModeSchema>;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const SessionMetadataSchema = StrictObject({
	id: IdSchema,
	createdAt: TimestampSchema,
	updatedAt: Type.Optional(TimestampSchema),
	parentSessionId: Type.Optional(IdSchema),
	sessionName: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});
export type SessionMetadata = Static<typeof SessionMetadataSchema>;

export const SessionSnapshotSchema = StrictObject({
	id: IdSchema,
	name: Type.Optional(Type.String()),
	cwd: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	phase: SessionPhaseSchema,
	model: ModelRefSchema,
	/** Scoped models used for cycling (authoritative, needed for model parity/reconnect). */
	scopedModels: Type.Array(ModelRefSchema),
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	locked: Type.Boolean(),
	revision: Type.Integer({ minimum: 0 }),
	/** Monotonic per-session event cursor of the last applied progress event. */
	eventCursor: NonnegativeSafeIntegerSchema,
	lease: SessionLeaseSchema,
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteer: Type.Array(UserTranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
	queuedFollowUp: Type.Array(UserTranscriptItemSchema),
	queuedFollowUpCount: Type.Integer({ minimum: 0 }),
	steeringMode: QueueModeSchema,
	followUpMode: QueueModeSchema,
	surface: SurfaceStateSchema,
	pendingInteractions: Type.Array(InteractionRequestSchema),
});
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const ServerSnapshotSchema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	sessions: Type.Array(SessionMetadataSchema),
	models: Type.Array(ModelMetadataSchema),
});
export type ServerSnapshot = Static<typeof ServerSnapshotSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
	Type.Literal("not_implemented"),
	Type.Literal("internal_error"),
	Type.Literal("unauthorized"),
	Type.Literal("interaction_timeout"),
	Type.Literal("payload_too_large"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

// ---------------------------------------------------------------------------
// Tree / navigation
// ---------------------------------------------------------------------------

const TreeEntryBaseProperties = {
	id: IdSchema,
	parentId: Type.Union([IdSchema, Type.Null()]),
	timestamp: TimestampStringSchema,
} as const;

const MessageTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("message"),
	message: JsonValueSchema,
});
const ThinkingLevelChangeTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("thinking_level_change"),
	thinkingLevel: IdSchema,
});
const ModelChangeTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("model_change"),
	provider: IdSchema,
	modelId: IdSchema,
});
const CompactionTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("compaction"),
	summary: Type.String(),
	firstKeptEntryId: Type.String(),
	tokensBefore: NonnegativeSafeIntegerSchema,
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	fromHook: Type.Optional(Type.Boolean()),
});
const BranchSummaryTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("branch_summary"),
	fromId: Type.String(),
	summary: Type.String(),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	fromHook: Type.Optional(Type.Boolean()),
});
const CustomTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("custom"),
	customType: Type.String(),
	data: Type.Optional(JsonValueSchema),
});
const CustomMessageTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("custom_message"),
	customType: Type.String(),
	content: JsonValueSchema,
	details: Type.Optional(JsonValueSchema),
	display: Type.Boolean(),
});
const LabelTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("label"),
	targetId: Type.String(),
	label: Type.Union([Type.String(), Type.Null()]),
});
const SessionInfoTreeEntrySchema = StrictObject({
	...TreeEntryBaseProperties,
	type: Type.Literal("session_info"),
	name: Type.Optional(Type.String()),
});
export const TreeEntrySchema = Type.Union([
	MessageTreeEntrySchema,
	ThinkingLevelChangeTreeEntrySchema,
	ModelChangeTreeEntrySchema,
	CompactionTreeEntrySchema,
	BranchSummaryTreeEntrySchema,
	CustomTreeEntrySchema,
	CustomMessageTreeEntrySchema,
	LabelTreeEntrySchema,
	SessionInfoTreeEntrySchema,
]);
export type TreeEntry = Static<typeof TreeEntrySchema>;

const SessionTreeNodeRecursiveSchema = Type.Cyclic(
	{
		SessionTreeNode: StrictObject({
			entry: TreeEntrySchema,
			children: Type.Array(Type.Ref("SessionTreeNode")),
			label: Type.Optional(Type.String()),
			labelTimestamp: Type.Optional(TimestampStringSchema),
		}),
	},
	"SessionTreeNode",
);
export const SessionTreeNodeSchema = Type.Unsafe(SessionTreeNodeRecursiveSchema);
export type SessionTreeNode = Static<typeof SessionTreeNodeSchema>;

// ---------------------------------------------------------------------------
// Read-model result shapes (statistics, todos, tasks, ssh, subagents, review)
// ---------------------------------------------------------------------------

export const SessionStatsSchema = StrictObject({
	sessionFile: Type.Optional(Type.String({ minLength: 1 })),
	sessionId: IdSchema,
	userMessages: NonnegativeSafeIntegerSchema,
	assistantMessages: NonnegativeSafeIntegerSchema,
	toolCalls: NonnegativeSafeIntegerSchema,
	toolResults: NonnegativeSafeIntegerSchema,
	totalMessages: NonnegativeSafeIntegerSchema,
	tokens: StrictObject({
		input: NonnegativeSafeIntegerSchema,
		output: NonnegativeSafeIntegerSchema,
		cacheRead: NonnegativeSafeIntegerSchema,
		cacheWrite: NonnegativeSafeIntegerSchema,
		total: NonnegativeSafeIntegerSchema,
	}),
	cost: Type.Number({ minimum: 0 }),
	contextUsage: Type.Optional(JsonValueSchema),
});
export type SessionStats = Static<typeof SessionStatsSchema>;

export const TodoItemSchema = StrictObject({
	id: IdSchema,
	content: Type.String(),
	status: Type.Union([
		Type.Literal("pending"),
		Type.Literal("in_progress"),
		Type.Literal("completed"),
		Type.Literal("cancelled"),
	]),
	details: Type.Optional(JsonValueSchema),
});
export type TodoItem = Static<typeof TodoItemSchema>;

export const TaskInfoSchema = StrictObject({
	id: IdSchema,
	label: Type.String(),
	status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error"), Type.Literal("killed")]),
	startedAt: TimestampSchema,
	finishedAt: Type.Optional(TimestampSchema),
	exitCode: Type.Optional(Type.Integer()),
});
export type TaskInfo = Static<typeof TaskInfoSchema>;

export const SshConnectionInfoSchema = StrictObject({
	host: IdSchema,
	connected: Type.Boolean(),
	lastUsedAt: Type.Optional(TimestampSchema),
});
export type SshConnectionInfo = Static<typeof SshConnectionInfoSchema>;

export const SubagentInfoSchema = StrictObject({
	id: IdSchema,
	worktree: Type.String({ minLength: 1 }),
	status: Type.Union([
		Type.Literal("running"),
		Type.Literal("done"),
		Type.Literal("error"),
		Type.Literal("cancelled"),
		Type.Literal("timeout"),
		Type.Literal("merged"),
		Type.Literal("rejected"),
		Type.Literal("interrupted"),
	]),
	/** Original task text. */
	task: Type.Optional(Type.String()),
	/** Resolved model (provider/id). */
	model: Type.Optional(Type.String()),
	/** Id of the spawning agent (tree tracking). */
	parentId: Type.Optional(IdSchema),
	/** Depth in the spawn tree. */
	depth: Type.Optional(Type.Integer({ minimum: 0 })),
	/** True when subagent_followup can re-task this agent on its branch. */
	followup: Type.Optional(Type.Boolean()),
});
export type SubagentInfo = Static<typeof SubagentInfoSchema>;

export const ReviewItemSchema = StrictObject({
	id: IdSchema,
	kind: Type.Union([Type.Literal("compaction"), Type.Literal("flag")]),
	status: Type.Union([
		Type.Literal("pending"),
		Type.Literal("approved"),
		Type.Literal("edited"),
		Type.Literal("cancelled"),
	]),
	summary: Type.Optional(Type.String()),
	details: Type.Optional(JsonValueSchema),
});
export type ReviewItem = Static<typeof ReviewItemSchema>;

export const ReviewDecisionSchema = Type.Union([
	StrictObject({ kind: Type.Literal("approve") }),
	StrictObject({ kind: Type.Literal("edit"), summary: Type.String() }),
	StrictObject({ kind: Type.Literal("cancel"), reason: Type.Optional(Type.String()) }),
]);
export type ReviewDecision = Static<typeof ReviewDecisionSchema>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const PromptPayloadProperties = {
	sessionId: IdSchema,
	content: Type.Array(MessagePartSchema),
} as const;

export const ListCommandSchema = StrictObject({ command: Type.Literal("list") });
export const CreateCommandSchema = StrictObject({
	command: Type.Literal("create"),
	leaseMode: LeaseModeSchema,
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String()),
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export const AttachCommandSchema = StrictObject({
	command: Type.Literal("attach"),
	sessionId: IdSchema,
	leaseMode: LeaseModeSchema,
});
export const DetachCommandSchema = StrictObject({ command: Type.Literal("detach"), sessionId: IdSchema });
export const PromptCommandSchema = StrictObject({ command: Type.Literal("prompt"), ...PromptPayloadProperties });
export const SteerCommandSchema = StrictObject({ command: Type.Literal("steer"), ...PromptPayloadProperties });
export const FollowUpCommandSchema = StrictObject({ command: Type.Literal("follow_up"), ...PromptPayloadProperties });
export const ClearQueueCommandSchema = StrictObject({
	command: Type.Literal("clear_queue"),
	sessionId: IdSchema,
	queue: Type.Optional(QueueKindSchema),
});
export const SetQueueModeCommandSchema = StrictObject({
	command: Type.Literal("set_queue_mode"),
	sessionId: IdSchema,
	queue: QueueKindSchema,
	mode: QueueModeSchema,
});
export const AbortCommandSchema = StrictObject({ command: Type.Literal("abort"), sessionId: IdSchema });
export const GetTreeCommandSchema = StrictObject({ command: Type.Literal("get_tree"), sessionId: IdSchema });
export const NavigateTreeCommandSchema = StrictObject({
	command: Type.Literal("navigate_tree"),
	sessionId: IdSchema,
	targetId: IdSchema,
	summarize: Type.Optional(Type.Boolean()),
	customInstructions: Type.Optional(Type.String()),
	replaceInstructions: Type.Optional(Type.Boolean()),
	label: Type.Optional(Type.String()),
});
export const GetSessionStatsCommandSchema = StrictObject({
	command: Type.Literal("get_session_stats"),
	sessionId: IdSchema,
});
export const SetNameCommandSchema = StrictObject({
	command: Type.Literal("set_name"),
	sessionId: IdSchema,
	name: Type.String(),
});
export const ForkCommandSchema = StrictObject({
	command: Type.Literal("fork"),
	sessionId: IdSchema,
	entryId: IdSchema,
});
export const CloneCommandSchema = StrictObject({ command: Type.Literal("clone"), sessionId: IdSchema });
export const CompactCommandSchema = StrictObject({
	command: Type.Literal("compact"),
	sessionId: IdSchema,
	customInstructions: Type.Optional(Type.String()),
});
export const SetAutoCompactionCommandSchema = StrictObject({
	command: Type.Literal("set_auto_compaction"),
	sessionId: IdSchema,
	enabled: Type.Boolean(),
});
export const AbortCompactionCommandSchema = StrictObject({
	command: Type.Literal("abort_compaction"),
	sessionId: IdSchema,
});
export const GetReviewStateCommandSchema = StrictObject({
	command: Type.Literal("get_review_state"),
	sessionId: IdSchema,
});
export const RespondReviewCommandSchema = StrictObject({
	command: Type.Literal("respond_review"),
	sessionId: IdSchema,
	reviewId: IdSchema,
	decision: ReviewDecisionSchema,
});
export const GetAvailableModelsCommandSchema = StrictObject({
	command: Type.Literal("get_available_models"),
	sessionId: IdSchema,
});
export const SetModelCommandSchema = StrictObject({
	command: Type.Literal("set_model"),
	sessionId: IdSchema,
	model: ModelRefSchema,
});
export const CycleModelCommandSchema = StrictObject({
	command: Type.Literal("cycle_model"),
	sessionId: IdSchema,
	/** Cycle direction; defaults to "forward" when omitted. */
	direction: Type.Optional(Type.Union([Type.Literal("forward"), Type.Literal("backward")])),
});
export const SetScopedModelsCommandSchema = StrictObject({
	command: Type.Literal("set_scoped_models"),
	sessionId: IdSchema,
	models: Type.Array(ModelRefSchema),
});
export const SetThinkingCommandSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	sessionId: IdSchema,
	thinkingLevel: ThinkingLevelSchema,
});
export const CycleThinkingCommandSchema = StrictObject({
	command: Type.Literal("cycle_thinking"),
	sessionId: IdSchema,
});
export const GetAvailableThinkingLevelsCommandSchema = StrictObject({
	command: Type.Literal("get_available_thinking_levels"),
	sessionId: IdSchema,
});
export const GetSettingsCommandSchema = StrictObject({ command: Type.Literal("get_settings") });
export const SetSettingCommandSchema = StrictObject({
	command: Type.Literal("set_setting"),
	key: Type.String({ minLength: 1 }),
	value: JsonValueSchema,
});
export const LoginCommandSchema = StrictObject({
	command: Type.Literal("login"),
	provider: IdSchema,
});
export const LogoutCommandSchema = StrictObject({
	command: Type.Literal("logout"),
	provider: IdSchema,
});
export const SetTrustCommandSchema = StrictObject({
	command: Type.Literal("set_trust"),
	sessionId: IdSchema,
	cwd: Type.String({ minLength: 1 }),
	trusted: Type.Boolean(),
	persist: Type.Boolean(),
});
export const ReloadCommandSchema = StrictObject({ command: Type.Literal("reload"), sessionId: IdSchema });
export const BashCommandSchema = StrictObject({
	command: Type.Literal("bash"),
	sessionId: IdSchema,
	commandLine: Type.String({ minLength: 1 }),
	excludeFromContext: Type.Optional(Type.Boolean()),
});
export const AbortBashCommandSchema = StrictObject({ command: Type.Literal("abort_bash"), sessionId: IdSchema });
export const GetTodosCommandSchema = StrictObject({ command: Type.Literal("get_todos"), sessionId: IdSchema });
export const ListTasksCommandSchema = StrictObject({ command: Type.Literal("list_tasks"), sessionId: IdSchema });
export const GetTaskOutputCommandSchema = StrictObject({
	command: Type.Literal("get_task_output"),
	sessionId: IdSchema,
	taskId: IdSchema,
});
export const KillTaskCommandSchema = StrictObject({
	command: Type.Literal("kill_task"),
	sessionId: IdSchema,
	taskId: IdSchema,
});
export const AttachTaskCommandSchema = StrictObject({
	command: Type.Literal("attach_task"),
	sessionId: IdSchema,
	taskId: IdSchema,
});
export const SshStatusCommandSchema = StrictObject({ command: Type.Literal("ssh_status"), sessionId: IdSchema });
export const SshConnectCommandSchema = StrictObject({
	command: Type.Literal("ssh_connect"),
	sessionId: IdSchema,
	host: IdSchema,
	port: Type.Optional(NonnegativeSafeIntegerSchema),
	jump: Type.Optional(Type.String({ minLength: 1 })),
	remoteCommand: Type.Optional(Type.String()),
});
export const SshCommandCommandSchema = StrictObject({
	command: Type.Literal("ssh_command"),
	sessionId: IdSchema,
	host: IdSchema,
	remoteCommand: Type.String({ minLength: 1 }),
});
export const SshSudoCommandSchema = StrictObject({
	command: Type.Literal("ssh_sudo"),
	sessionId: IdSchema,
	host: IdSchema,
});
export const SshCloseCommandSchema = StrictObject({
	command: Type.Literal("ssh_close"),
	sessionId: IdSchema,
	host: IdSchema,
});
export const GetSubagentsCommandSchema = StrictObject({
	command: Type.Literal("get_subagents"),
	sessionId: IdSchema,
});
export const ImportSessionCommandSchema = StrictObject({
	command: Type.Literal("import_session"),
	blob: BlobReferenceSchema,
});
export const ExportSessionCommandSchema = StrictObject({
	command: Type.Literal("export_session"),
	sessionId: IdSchema,
	format: Type.Union([Type.Literal("html"), Type.Literal("jsonl")]),
});
export const ShareAsGistCommandSchema = StrictObject({
	command: Type.Literal("share_as_gist"),
	sessionId: IdSchema,
});
export const RespondInteractionCommandSchema = StrictObject({
	command: Type.Literal("respond_interaction"),
	sessionId: IdSchema,
	interactionId: IdSchema,
	result: InteractionResponseSchema,
});
export const ResyncCommandSchema = StrictObject({ command: Type.Literal("resync"), sessionId: IdSchema });

export const CommandSchema = Type.Union([
	ListCommandSchema,
	CreateCommandSchema,
	AttachCommandSchema,
	DetachCommandSchema,
	PromptCommandSchema,
	SteerCommandSchema,
	FollowUpCommandSchema,
	ClearQueueCommandSchema,
	SetQueueModeCommandSchema,
	AbortCommandSchema,
	GetTreeCommandSchema,
	NavigateTreeCommandSchema,
	GetSessionStatsCommandSchema,
	SetNameCommandSchema,
	ForkCommandSchema,
	CloneCommandSchema,
	CompactCommandSchema,
	SetAutoCompactionCommandSchema,
	AbortCompactionCommandSchema,
	GetReviewStateCommandSchema,
	RespondReviewCommandSchema,
	GetAvailableModelsCommandSchema,
	SetModelCommandSchema,
	CycleModelCommandSchema,
	SetScopedModelsCommandSchema,
	SetThinkingCommandSchema,
	CycleThinkingCommandSchema,
	GetAvailableThinkingLevelsCommandSchema,
	GetSettingsCommandSchema,
	SetSettingCommandSchema,
	LoginCommandSchema,
	LogoutCommandSchema,
	SetTrustCommandSchema,
	ReloadCommandSchema,
	BashCommandSchema,
	AbortBashCommandSchema,
	GetTodosCommandSchema,
	ListTasksCommandSchema,
	GetTaskOutputCommandSchema,
	KillTaskCommandSchema,
	AttachTaskCommandSchema,
	SshStatusCommandSchema,
	SshConnectCommandSchema,
	SshCommandCommandSchema,
	SshSudoCommandSchema,
	SshCloseCommandSchema,
	GetSubagentsCommandSchema,
	ImportSessionCommandSchema,
	ExportSessionCommandSchema,
	ShareAsGistCommandSchema,
	RespondInteractionCommandSchema,
	ResyncCommandSchema,
]);
export type Command = Static<typeof CommandSchema>;
export type CommandName = Command["command"];

/**
 * Classification of a session command with respect to an exclusive lease.
 * `read` commands are safe for shared observers, `mutation` commands require
 * the exclusive controller, and `free` commands are not session-scoped and are
 * dispatched without lease checks.
 *
 * This is a single browser-safe pure classifier shared by server and client so
 * the two sides can never drift on what shared observers may do. It is
 * deliberately **fail-closed**: anything not explicitly enumerated below is
 * `mutation` (and any command outside the session scope is `free`).
 */
export type SessionCommandLeaseRole = "read" | "mutation" | "free";

const SHARED_READ_COMMANDS = new Set<string>([
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
]);

const FREE_COMMANDS = new Set<string>([
	"list",
	"create",
	"attach",
	"get_settings",
	"set_setting",
	"login",
	"logout",
	"import_session",
]);

/** `resync` and `detach` are allowed for shared observers but are not `read`s. */
const SHARED_ALLOWED_COMMANDS = new Set<string>([...SHARED_READ_COMMANDS, "resync", "detach"]);

/** True when a shared observer may issue `command` against an attached session. */
export function isSharedAllowedCommand(command: CommandName): boolean {
	return SHARED_ALLOWED_COMMANDS.has(command);
}

/** The exclusive-lease role of a command: `read`, `mutation`, or `free`. */
export function commandLeaseRole(command: CommandName): SessionCommandLeaseRole {
	if (FREE_COMMANDS.has(command)) return "free";
	if (SHARED_READ_COMMANDS.has(command)) return "read";
	return "mutation";
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Most mutation commands return the authoritative session snapshot. */
function snapshotResultSchema<const C extends string>(command: C) {
	return Type.Object(
		{ command: Type.Literal(command), session: SessionSnapshotSchema },
		{ additionalProperties: false },
	);
}

export const ListResultSchema = StrictObject({
	command: Type.Literal("list"),
	sessions: Type.Array(SessionMetadataSchema),
});
export const DetachResultSchema = StrictObject({
	command: Type.Literal("detach"),
	sessionId: IdSchema,
});
export const CreateResultSchema = snapshotResultSchema("create");
export const AttachResultSchema = snapshotResultSchema("attach");
export const PromptResultSchema = snapshotResultSchema("prompt");
export const SteerResultSchema = snapshotResultSchema("steer");
export const FollowUpResultSchema = snapshotResultSchema("follow_up");
export const ClearQueueResultSchema = snapshotResultSchema("clear_queue");
export const SetQueueModeResultSchema = snapshotResultSchema("set_queue_mode");
export const AbortResultSchema = snapshotResultSchema("abort");
export const SetModelResultSchema = snapshotResultSchema("set_model");
/** The cycled-to model (or null when no cycle was possible, e.g. <2 candidates). */
export const ModelCycleResultSchema = StrictObject({
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	isScoped: Type.Boolean(),
});
export type ModelCycleResult = Static<typeof ModelCycleResultSchema>;
export const CycleModelResultSchema = StrictObject({
	command: Type.Literal("cycle_model"),
	session: SessionSnapshotSchema,
	cycle: Type.Union([ModelCycleResultSchema, Type.Null()]),
});
export const SetScopedModelsResultSchema = snapshotResultSchema("set_scoped_models");
export const SetNameResultSchema = snapshotResultSchema("set_name");
export const ForkResultSchema = snapshotResultSchema("fork");
export const CloneResultSchema = snapshotResultSchema("clone");
export const CompactResultSchema = snapshotResultSchema("compact");
export const SetAutoCompactionResultSchema = snapshotResultSchema("set_auto_compaction");
export const AbortCompactionResultSchema = snapshotResultSchema("abort_compaction");
export const RespondReviewResultSchema = snapshotResultSchema("respond_review");
export const SetTrustResultSchema = snapshotResultSchema("set_trust");
export const ReloadResultSchema = snapshotResultSchema("reload");
export const BashResultSchema = snapshotResultSchema("bash");
export const AbortBashResultSchema = snapshotResultSchema("abort_bash");
export const KillTaskResultSchema = snapshotResultSchema("kill_task");
export const ImportSessionResultSchema = snapshotResultSchema("import_session");

export const SetThinkingResultSchema = snapshotResultSchema("set_thinking");
export const CycleThinkingResultSchema = StrictObject({
	command: Type.Literal("cycle_thinking"),
	session: SessionSnapshotSchema,
	/** New level, or null when cycling is unsupported (model has no thinking). */
	thinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
});

export const GetTreeResultSchema = StrictObject({
	command: Type.Literal("get_tree"),
	tree: Type.Array(SessionTreeNodeSchema),
	leafId: Type.Union([IdSchema, Type.Null()]),
});
export const FileRevertResultSchema = StrictObject({
	reverted: Type.Array(Type.String({ minLength: 1 })),
	skipped: Type.Array(Type.String({ minLength: 1 })),
});
export type FileRevertResult = Static<typeof FileRevertResultSchema>;

export const BranchSummaryEntryResultSchema = StrictObject({
	type: Type.Literal("branch_summary"),
	id: IdSchema,
	parentId: Type.Union([IdSchema, Type.Null()]),
	timestamp: TimestampStringSchema,
	fromId: Type.String(),
	summary: Type.String(),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	fromHook: Type.Optional(Type.Boolean()),
});
export type BranchSummaryEntryResult = Static<typeof BranchSummaryEntryResultSchema>;

export const NavigateTreeResultSchema = StrictObject({
	command: Type.Literal("navigate_tree"),
	session: SessionSnapshotSchema,
	/** True when a hook/extension cancelled navigation; false for a no-op or completed navigation. */
	cancelled: Type.Boolean(),
	aborted: Type.Optional(Type.Boolean()),
	editorText: Type.Optional(Type.String()),
	summaryEntry: Type.Optional(BranchSummaryEntryResultSchema),
	fileRevert: Type.Optional(FileRevertResultSchema),
});
export const GetSessionStatsResultSchema = StrictObject({
	command: Type.Literal("get_session_stats"),
	sessionId: IdSchema,
	stats: SessionStatsSchema,
});
export const GetReviewStateResultSchema = StrictObject({
	command: Type.Literal("get_review_state"),
	sessionId: IdSchema,
	items: Type.Array(ReviewItemSchema),
});
export const GetAvailableModelsResultSchema = StrictObject({
	command: Type.Literal("get_available_models"),
	models: Type.Array(ModelMetadataSchema),
});
export const GetAvailableThinkingLevelsResultSchema = StrictObject({
	command: Type.Literal("get_available_thinking_levels"),
	levels: Type.Array(ThinkingLevelSchema),
});
export const GetSettingsResultSchema = StrictObject({
	command: Type.Literal("get_settings"),
	settings: Type.Record(Type.String(), JsonValueSchema),
});
export const SetSettingResultSchema = StrictObject({
	command: Type.Literal("set_setting"),
	key: Type.String({ minLength: 1 }),
	value: JsonValueSchema,
});
export const LoginResultSchema = StrictObject({ command: Type.Literal("login"), provider: IdSchema });
export const LogoutResultSchema = StrictObject({ command: Type.Literal("logout"), provider: IdSchema });
export const GetTodosResultSchema = StrictObject({
	command: Type.Literal("get_todos"),
	sessionId: IdSchema,
	todos: Type.Array(TodoItemSchema),
});
export const ListTasksResultSchema = StrictObject({
	command: Type.Literal("list_tasks"),
	sessionId: IdSchema,
	tasks: Type.Array(TaskInfoSchema),
});
export const GetTaskOutputResultSchema = StrictObject({
	command: Type.Literal("get_task_output"),
	sessionId: IdSchema,
	taskId: IdSchema,
	output: Type.String(),
});
export const AttachTaskResultSchema = StrictObject({
	command: Type.Literal("attach_task"),
	sessionId: IdSchema,
	taskId: IdSchema,
});
export const SshStatusResultSchema = StrictObject({
	command: Type.Literal("ssh_status"),
	sessionId: IdSchema,
	connections: Type.Array(SshConnectionInfoSchema),
});
export const SshConnectResultSchema = StrictObject({ command: Type.Literal("ssh_connect"), host: IdSchema });
export const SshCommandResultSchema = StrictObject({
	command: Type.Literal("ssh_command"),
	host: IdSchema,
	output: Type.String(),
});
export const SshSudoResultSchema = StrictObject({ command: Type.Literal("ssh_sudo"), host: IdSchema });
export const SshCloseResultSchema = StrictObject({ command: Type.Literal("ssh_close"), host: IdSchema });
export const GetSubagentsResultSchema = StrictObject({
	command: Type.Literal("get_subagents"),
	sessionId: IdSchema,
	subagents: Type.Array(SubagentInfoSchema),
});
export const ExportSessionResultSchema = StrictObject({
	command: Type.Literal("export_session"),
	blob: BlobReferenceSchema,
});
export const ShareAsGistResultSchema = StrictObject({
	command: Type.Literal("share_as_gist"),
	url: Type.String({ minLength: 1 }),
});
export const RespondInteractionResultSchema = StrictObject({
	command: Type.Literal("respond_interaction"),
	status: Type.Union([Type.Literal("accepted"), Type.Literal("settled"), Type.Literal("not_found")]),
});
export const ResyncResultSchema = StrictObject({
	command: Type.Literal("resync"),
	session: SessionSnapshotSchema,
});

export const CommandResultSchema = Type.Union([
	ListResultSchema,
	CreateResultSchema,
	AttachResultSchema,
	DetachResultSchema,
	PromptResultSchema,
	SteerResultSchema,
	FollowUpResultSchema,
	ClearQueueResultSchema,
	SetQueueModeResultSchema,
	AbortResultSchema,
	GetTreeResultSchema,
	NavigateTreeResultSchema,
	GetSessionStatsResultSchema,
	SetNameResultSchema,
	ForkResultSchema,
	CloneResultSchema,
	CompactResultSchema,
	SetAutoCompactionResultSchema,
	AbortCompactionResultSchema,
	GetReviewStateResultSchema,
	RespondReviewResultSchema,
	GetAvailableModelsResultSchema,
	SetModelResultSchema,
	CycleModelResultSchema,
	SetScopedModelsResultSchema,
	SetThinkingResultSchema,
	CycleThinkingResultSchema,
	GetAvailableThinkingLevelsResultSchema,
	GetSettingsResultSchema,
	SetSettingResultSchema,
	LoginResultSchema,
	LogoutResultSchema,
	SetTrustResultSchema,
	ReloadResultSchema,
	BashResultSchema,
	AbortBashResultSchema,
	GetTodosResultSchema,
	ListTasksResultSchema,
	GetTaskOutputResultSchema,
	KillTaskResultSchema,
	AttachTaskResultSchema,
	SshStatusResultSchema,
	SshConnectResultSchema,
	SshCommandResultSchema,
	SshSudoResultSchema,
	SshCloseResultSchema,
	GetSubagentsResultSchema,
	ImportSessionResultSchema,
	ExportSessionResultSchema,
	ShareAsGistResultSchema,
	RespondInteractionResultSchema,
	ResyncResultSchema,
]);
export type CommandResult = Static<typeof CommandResultSchema>;

/** Correlates a command with its result payload via the shared `command` discriminator. */
export type ResultForCommand<TCommand extends Command> = Extract<CommandResult, { command: TCommand["command"] }>;

// ---------------------------------------------------------------------------
// Client messages
// ---------------------------------------------------------------------------

/** Must be the first frame sent by a client. Version is intentionally an integer, not a coercible string. */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	request: CommandSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server messages and events
// ---------------------------------------------------------------------------

export const SurfaceUpdateOperationSchema = Type.Union([
	StrictObject({
		op: Type.Literal("notify"),
		message: Type.String({ minLength: 1 }),
		kind: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")])),
	}),
	StrictObject({ op: Type.Literal("set_status"), key: IdSchema, text: Type.Union([Type.String(), Type.Null()]) }),
	StrictObject({
		op: Type.Literal("set_working_message"),
		message: Type.Union([Type.String(), Type.Null()]),
	}),
	StrictObject({ op: Type.Literal("set_working_visible"), visible: Type.Boolean() }),
	StrictObject({
		op: Type.Literal("set_working_indicator"),
		indicator: Type.Union([WorkingIndicatorConfigSchema, Type.Null()]),
	}),
	StrictObject({
		op: Type.Literal("set_hidden_thinking_label"),
		label: Type.Union([Type.String(), Type.Null()]),
	}),
	StrictObject({
		op: Type.Literal("set_widget"),
		key: IdSchema,
		lines: Type.Union([Type.Array(Type.String()), Type.Null()]),
		placement: Type.Optional(WidgetPlacementSchema),
	}),
	StrictObject({ op: Type.Literal("set_title"), title: Type.Union([Type.String(), Type.Null()]) }),
	StrictObject({ op: Type.Literal("set_editor_text"), text: Type.String() }),
	StrictObject({ op: Type.Literal("set_theme"), theme: Type.Union([Type.String(), Type.Null()]) }),
	StrictObject({ op: Type.Literal("set_tools_expanded"), expanded: Type.Boolean() }),
]);
export type SurfaceUpdateOperation = Static<typeof SurfaceUpdateOperationSchema>;

const LeaseLostReasonSchema = Type.Union([Type.Literal("revoked"), Type.Literal("demoted")]);
export type LeaseLostReason = Static<typeof LeaseLostReasonSchema>;

export const ServerEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("server_snapshot"), snapshot: ServerSnapshotSchema }),
	StrictObject({ type: Type.Literal("session_snapshot"), snapshot: SessionSnapshotSchema }),
	StrictObject({
		type: Type.Literal("session_progress"),
		eventCursor: NonnegativeSafeIntegerSchema,
		sessionId: IdSchema,
		progress: TranscriptProgressSchema,
	}),
	StrictObject({
		type: Type.Literal("surface_update"),
		eventCursor: NonnegativeSafeIntegerSchema,
		sessionId: IdSchema,
		operation: SurfaceUpdateOperationSchema,
	}),
	StrictObject({
		type: Type.Literal("interaction_request"),
		eventCursor: NonnegativeSafeIntegerSchema,
		sessionId: IdSchema,
		request: InteractionRequestSchema,
	}),
	StrictObject({
		type: Type.Literal("queue_update"),
		eventCursor: NonnegativeSafeIntegerSchema,
		sessionId: IdSchema,
		queue: QueueKindSchema,
		mode: QueueModeSchema,
		queuedCount: NonnegativeSafeIntegerSchema,
	}),
	StrictObject({ type: Type.Literal("lease_lost"), sessionId: IdSchema, reason: LeaseLostReasonSchema }),
	StrictObject({ type: Type.Literal("error"), error: ProtocolErrorSchema }),
	StrictObject({ type: Type.Literal("session_removed"), sessionId: IdSchema }),
]);
export type ServerEvent = Static<typeof ServerEventSchema>;

export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	connectionId: IdSchema,
	snapshot: ServerSnapshotSchema,
});
export const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
export const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: CommandResultSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
export const EventEnvelopeSchema = StrictObject({
	type: Type.Literal("event"),
	event: ServerEventSchema,
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	EventEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
