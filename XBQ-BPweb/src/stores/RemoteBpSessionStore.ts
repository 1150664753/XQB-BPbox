import type {
  BpAction,
  BpActionResult,
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

  constructor(private readonly connection: RemoteBpConnection) {
    this.snapshot = {
      connection: connection.getSnapshot(),
      room: null,
      bpState: null,
      feedback: null,
      error: null,
      pendingActionId: null,
    };
    this.unsubscribers = [
      connection.on("connectionStateChanged", (next) => {
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
      connection.on("error", (error) =>
        this.patch({
          error,
          feedback: { tone: "error", message: error.message },
          pendingActionId: null,
        }),
      ),
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
    if (!bpState || !room) return;
    const selected = bpState.selectionTargets[room.side];
    const isSelected = selected?.kind === kind && selected.id === targetId;
    const action: BpAction = isSelected
      ? this.createBaseAction("DESELECT", [])
      : this.createBaseAction("SELECT", [{ kind, id: targetId }]);
    await this.submitAction(action);
  }

  async confirm(): Promise<void> {
    if (!this.snapshot.bpState || !this.snapshot.room) return;
    await this.submitAction(this.createBaseAction("CONFIRM", []));
  }

  async refreshState(): Promise<void> {
    await this.connection.requestState(this.snapshot.bpState?.revision);
  }

  clearFeedback(): void {
    this.patch({ feedback: null });
  }

  destroy(): void {
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
    this.patch({
      pendingActionId: action.actionId,
      feedback: {
        tone: "info",
        message: "操作请求已发送，等待房主确认…",
        actionId: action.actionId,
      },
    });
    try {
      await this.connection.sendAction(action);
    } catch (error) {
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
    this.patch({ bpState: state });
  }

  private acceptActionResult(result: BpActionResult): void {
    this.patch({
      pendingActionId:
        this.snapshot.pendingActionId === result.actionId
          ? null
          : this.snapshot.pendingActionId,
      feedback: {
        tone: result.accepted ? "success" : "error",
        message: result.message,
        actionId: result.actionId,
      },
    });
  }

  private patch(patch: Partial<RemoteBpSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
