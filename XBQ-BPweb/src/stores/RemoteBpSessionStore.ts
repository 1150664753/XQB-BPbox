import type {
  BpAction,
  BpActionResult,
  BpActionTarget,
  PlayerSide,
  RemoteBpState,
} from "../types/bp";
import type {
  ConnectionSnapshot,
  RemoteConnectionError,
} from "../types/connection";
import type {
  RemoteBpConnectOptions,
  RemoteBpConnection,
} from "../services/RemoteBpConnection";
import { createMessageId } from "../protocol";

export interface JoinedRoomContext {
  roomId: string;
  side: PlayerSide;
  displayName: string;
  sessionId?: string;
}

export interface SessionFeedback {
  tone: "info" | "success" | "error";
  message: string;
  actionId?: string;
}

export interface RemoteBpSessionSnapshot {
  connection: ConnectionSnapshot;
  room: JoinedRoomContext | null;
  bpState: RemoteBpState | null;
  feedback: SessionFeedback | null;
  error: RemoteConnectionError | null;
  pendingActionId: string | null;
  pendingActionKind: BpAction["kind"] | null;
  /** Local selection intent only; the host still owns bpState and final results. */
  selectionPreview: BpActionTarget | null | undefined;
}

type StoreListener = () => void;

function createActionId(): string {
  return createMessageId();
}

/**
 * External observable store. It accepts authoritative states from the connection and never
 * applies BP results optimistically, so React cannot become the authority by accident.
 */
export class RemoteBpSessionStore {
  private readonly listeners = new Set<StoreListener>();
  private readonly unsubscribers: Array<() => void>;
  private snapshot: RemoteBpSessionSnapshot;
  private inFlight: { action: BpAction; result: BpActionResult | null } | null =
    null;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly connection: RemoteBpConnection) {
    this.snapshot = {
      connection: connection.getSnapshot(),
      room: null,
      bpState: null,
      feedback: null,
      error: null,
      pendingActionId: null,
      pendingActionKind: null,
      selectionPreview: undefined,
    };
    this.unsubscribers = [
      connection.on("connectionStateChanged", (next) => {
        if (next.state !== "connected") this.clearPending();
        const terminalMessage =
          next.state === "kicked"
            ? "已被房主踢出"
            : next.state === "room-closed"
              ? "房间已关闭"
              : null;
        this.patch({
          connection: next,
          ...(terminalMessage
            ? {
                pendingActionId: null,
                feedback: { tone: "error" as const, message: terminalMessage },
              }
            : {}),
        });
      }),
      connection.on("bpStateReceived", (state) => this.acceptState(state)),
      connection.on("bpStateUpdated", (state) => this.acceptState(state)),
      connection.on("actionResult", (result) =>
        this.acceptActionResult(result),
      ),
      connection.on("error", (error) => {
        // An image failure must not unlock a CONFIRM or discard a selection request.
        if (error.assetId) return;
        this.clearPending();
        this.patch({
          error,
          feedback: { tone: "error", message: error.message },
          pendingActionId: null,
        });
      }),
    ];
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RemoteBpSessionSnapshot {
    return this.snapshot;
  }

  async join(room: JoinedRoomContext): Promise<void> {
    this.clearPending();
    const normalizedRoom: JoinedRoomContext = {
      roomId: room.roomId.trim().toUpperCase(),
      side: room.side,
      displayName:
        room.displayName.trim().slice(0, 64) ||
        (room.side === "first" ? "先手" : "后手"),
    };
    this.patch({
      room: normalizedRoom,
      bpState: null,
      error: null,
      feedback: { tone: "info", message: "正在与房主建立连接…" },
    });

    const options: RemoteBpConnectOptions = {
      ...normalizedRoom,
      clientId: `web-${createActionId()}`,
      displayName: normalizedRoom.displayName,
    };
    try {
      const confirmed = await this.connection.connect(options);
      this.patch({
        room: {
          roomId: confirmed.roomId,
          side: confirmed.assignedSide,
          displayName: normalizedRoom.displayName,
          sessionId: confirmed.sessionId,
        },
        feedback: {
          tone: "success",
          message: `已作为${confirmed.assignedSide === "first" ? "先手" : "后手"}连接房主`,
        },
      });
    } catch (error) {
      this.patch({
        feedback: {
          tone: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async leave(): Promise<void> {
    this.clearPending();
    await this.connection.disconnect();
    this.patch({
      room: null,
      bpState: null,
      feedback: null,
      error: null,
      pendingActionId: null,
    });
  }

  async selectTarget(
    kind: "CHARACTER" | "LIGHT_CONE",
    targetId: string,
  ): Promise<void> {
    const { bpState, room } = this.snapshot;
    if (
      !bpState ||
      !room ||
      !this.canSelect() ||
      this.snapshot.pendingActionKind === "CONFIRM" ||
      !bpState.availableTargetIdsBySide[room.side].includes(targetId)
    )
      return;
    const selected =
      this.snapshot.selectionPreview !== undefined
        ? this.snapshot.selectionPreview
        : bpState.selectionTargets[room.side];
    const isSelected = selected?.kind === kind && selected.id === targetId;
    this.patch({
      selectionPreview: isSelected ? null : { kind, id: targetId },
    });
    await this.flushSelection();
  }

  async confirm(): Promise<void> {
    const { bpState, room } = this.snapshot;
    if (
      !bpState ||
      !room ||
      this.inFlight ||
      this.snapshot.selectionPreview !== undefined ||
      !this.canSelect() ||
      !bpState.canConfirmBySide[room.side]
    )
      return;
    await this.submitAction(this.createBaseAction("CONFIRM", []));
  }

  async refreshState(): Promise<void> {
    await this.connection.requestState(this.snapshot.bpState?.revision);
  }

  clearFeedback(): void {
    this.patch({ feedback: null });
  }

  destroy(): void {
    this.clearPending();
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.listeners.clear();
  }

  private createBaseAction(
    kind: "SELECT",
    targets: [{ kind: "CHARACTER" | "LIGHT_CONE"; id: string }],
  ): Extract<BpAction, { kind: "SELECT" }>;
  private createBaseAction(
    kind: "DESELECT" | "CONFIRM",
    targets: [],
  ): Extract<BpAction, { kind: "DESELECT" | "CONFIRM" }>;
  private createBaseAction(
    kind: "SELECT" | "DESELECT" | "CONFIRM",
    targets: [{ kind: "CHARACTER" | "LIGHT_CONE"; id: string }] | [],
  ): Extract<BpAction, { kind: "SELECT" | "DESELECT" | "CONFIRM" }> {
    const { room, bpState } = this.snapshot;
    if (!room || !bpState) throw new Error("BP session is not ready");
    return {
      actionId: createActionId(),
      actorSide: room.side,
      expectedRevision: bpState.revision,
      stepIndex: bpState.currentStep?.index ?? null,
      createdAt: new Date().toISOString(),
      kind,
      targets,
    } as Extract<BpAction, { kind: "SELECT" | "DESELECT" | "CONFIRM" }>;
  }

  private async submitAction(action: BpAction): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = { action, result: null };
    this.actionTimer = setTimeout(() => {
      if (this.inFlight?.action.actionId !== action.actionId) return;
      this.clearPending();
      this.patch({
        feedback: {
          tone: "error",
          message: "房主响应超时，正在重新同步状态，请稍后重试",
        },
      });
      void this.refreshState().catch(() => undefined);
    }, 15_000);
    this.patch({
      pendingActionId: action.actionId,
      pendingActionKind: action.kind,
      feedback: {
        tone: "info",
        message:
          action.kind === "CONFIRM"
            ? "操作请求已发送，等待房主确认…"
            : "正在同步选择，可继续切换…",
        actionId: action.actionId,
      },
    });
    try {
      await this.connection.sendAction(action);
    } catch (error) {
      if (this.inFlight?.action.actionId !== action.actionId) return;
      this.clearPending();
      this.patch({
        pendingActionId: null,
        feedback: {
          tone: "error",
          message: error instanceof Error ? error.message : String(error),
          actionId: action.actionId,
        },
      });
    }
  }

  private acceptState(state: RemoteBpState): void {
    if (
      this.snapshot.bpState &&
      state.revision < this.snapshot.bpState.revision
    ) {
      return;
    }
    const previous = this.snapshot.bpState;
    const contextChanged =
      previous &&
      (previous.sessionId !== state.sessionId ||
        previous.currentStep?.id !== state.currentStep?.id ||
        previous.currentStep?.index !== state.currentStep?.index ||
        previous.currentActor !== state.currentActor ||
        previous.currentOperation !== state.currentOperation ||
        previous.status !== state.status);
    this.patch({
      bpState: state,
      ...(contextChanged ? { selectionPreview: undefined } : {}),
    });
    if (!this.canSelect()) this.patch({ selectionPreview: undefined });
    this.finishAcknowledgedAction();
  }

  private acceptActionResult(result: BpActionResult): void {
    if (this.inFlight?.action.actionId !== result.actionId) return;
    this.inFlight.result = result;
    if (!result.accepted) {
      this.clearPending();
      this.patch({
        feedback: {
          tone: "error",
          message: result.message,
          actionId: result.actionId,
        },
      });
      if (
        result.code === "REVISION_CONFLICT" ||
        result.code === "STALE_REVISION"
      )
        void this.refreshState().catch(() => undefined);
      return;
    }
    this.finishAcknowledgedAction();
  }

  private finishAcknowledgedAction(): void {
    const result = this.inFlight?.result;
    // The host sends ACTION_RESULT before STATE_UPDATE. Do not submit the next
    // intent (or enable CONFIRM) with the preceding revision in that interval.
    if (
      !result ||
      (this.snapshot.bpState?.revision ?? -1) < result.resultingRevision
    )
      return;
    this.clearPending(false);
    this.patch({
      feedback: {
        tone: "success",
        message: result.message,
        actionId: result.actionId,
      },
    });
    void this.flushSelection();
  }

  private canSelect(): boolean {
    const { bpState: state, room, connection } = this.snapshot;
    return Boolean(
      state &&
      room &&
      connection.state === "connected" &&
      state.status === "running" &&
      !state.waitingForHost &&
      !state.confirmedSides[room.side] &&
      (state.currentActor === room.side ||
        ["PROTECT", "BORROW"].includes(state.currentOperation)),
    );
  }

  private async flushSelection(): Promise<void> {
    if (this.inFlight || this.snapshot.selectionPreview === undefined) return;
    const { bpState, room, selectionPreview: target } = this.snapshot;
    if (
      !bpState ||
      !room ||
      !this.canSelect() ||
      (target &&
        !bpState.availableTargetIdsBySide[room.side].includes(target.id))
    ) {
      this.patch({ selectionPreview: undefined });
      return;
    }
    const selected = bpState.selectionTargets[room.side];
    if (target?.kind === selected?.kind && target?.id === selected?.id) {
      this.patch({ selectionPreview: undefined });
      return;
    }
    await this.submitAction(
      target
        ? this.createBaseAction("SELECT", [
            { kind: target.kind, id: target.id },
          ])
        : this.createBaseAction("DESELECT", []),
    );
  }

  private clearPending(clearPreview = true): void {
    if (this.actionTimer !== null) clearTimeout(this.actionTimer);
    this.actionTimer = null;
    this.inFlight = null;
    this.patch({
      pendingActionId: null,
      pendingActionKind: null,
      ...(clearPreview ? { selectionPreview: undefined } : {}),
    });
  }

  private patch(patch: Partial<RemoteBpSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
