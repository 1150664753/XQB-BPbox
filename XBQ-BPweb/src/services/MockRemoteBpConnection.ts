import {
  MOCK_FLOW,
  createInitialMockState,
  createMockAsset,
  createMockAssetManifest,
} from "../mocks/mockData";
import type { AssetManifest } from "../types/assets";
import type {
  BpAction,
  BpActionTarget,
  BpActionResult,
  PlayerSide,
  RemoteBpOperation,
  RemoteBpState,
} from "../types/bp";
import type {
  ConnectionSnapshot,
  RemoteBpConnectionEvents,
} from "../types/connection";
import type {
  ConnectionEventListener,
  RemoteBpConnectOptions,
  RemoteBpConnectResult,
  RemoteBpConnection,
  Unsubscribe,
} from "./RemoteBpConnection";
import { TypedEventEmitter } from "./TypedEventEmitter";

export interface MockRemoteBpConnectionOptions {
  minLatencyMs?: number;
  maxLatencyMs?: number;
}

export class MockRemoteBpConnection implements RemoteBpConnection {
  private readonly events = new TypedEventEmitter<RemoteBpConnectionEvents>();
  private readonly processedActionIds = new Set<string>();
  private readonly timers = new Set<number>();
  private readonly manifest: AssetManifest = createMockAssetManifest();
  private readonly minLatencyMs: number;
  private readonly maxLatencyMs: number;
  private snapshot: ConnectionSnapshot = {
    state: "idle",
    transport: "mock",
    latencyMs: null,
    lastPingAt: null,
    reason: null,
  };
  private state: RemoteBpState | null = null;
  private playerSide: PlayerSide | null = null;

  constructor(options: MockRemoteBpConnectionOptions = {}) {
    this.minLatencyMs = options.minLatencyMs ?? 180;
    this.maxLatencyMs = options.maxLatencyMs ?? 460;
  }

  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }

  on<K extends keyof RemoteBpConnectionEvents>(
    event: K,
    listener: ConnectionEventListener<RemoteBpConnectionEvents[K]>,
  ): Unsubscribe {
    return this.events.on(event, listener);
  }

  async connect(
    options: RemoteBpConnectOptions,
  ): Promise<RemoteBpConnectResult> {
    this.clearTimers();
    this.processedActionIds.clear();
    this.playerSide = options.side;
    this.setConnectionState("connecting");
    await this.delay();

    const roomId = options.roomId.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(roomId)) {
      this.setConnectionState("failed", "房间号格式无效");
      this.events.emit("error", {
        code: "INVALID_ROOM",
        message: "房间号应为 4–12 位字母或数字",
        recoverable: true,
      });
      throw new Error("房间号格式无效");
    }

    this.state = createInitialMockState(roomId);
    this.state.teams[options.side] = {
      ...this.state.teams[options.side],
      name: options.displayName ?? (options.side === "first" ? "先手" : "后手"),
    };
    this.setConnectionState("connected");
    this.events.emit("assetManifestReceived", this.manifest);
    this.events.emit("bpStateReceived", this.cloneState());
    this.scheduleOpponentTurn();
    return {
      roomId,
      sessionId: this.state.sessionId,
      assignedSide: options.side,
    };
  }

  async disconnect(): Promise<void> {
    this.clearTimers();
    this.state = null;
    this.playerSide = null;
    this.setConnectionState("disconnected", "已主动离开房间");
  }

  async sendAction(action: BpAction): Promise<void> {
    await this.delay();
    const state = this.state;
    if (!state || !this.playerSide || this.snapshot.state !== "connected") {
      this.rejectAction(action.actionId, "SESSION_NOT_READY", "房间尚未连接");
      return;
    }

    if (this.processedActionIds.has(action.actionId)) {
      this.rejectAction(action.actionId, "DUPLICATE_REQUEST", "该请求已经处理");
      return;
    }
    this.processedActionIds.add(action.actionId);

    if (action.expectedRevision !== state.revision) {
      this.rejectAction(
        action.actionId,
        "STALE_REVISION",
        "状态版本已变化，请基于最新状态重试",
      );
      this.events.emit("bpStateReceived", this.cloneState());
      return;
    }
    if (
      action.actorSide !== this.playerSide ||
      state.currentActor !== this.playerSide
    ) {
      this.rejectAction(action.actionId, "NOT_YOUR_TURN", "当前尚未轮到你操作");
      return;
    }

    switch (action.kind) {
      case "SELECT": {
        const target = action.targets[0];
        if (
          !state.availableTargetIdsBySide[this.playerSide].includes(
            target.id,
          ) ||
          target.kind !== state.currentStep?.targetType
        ) {
          this.rejectAction(
            action.actionId,
            "INVALID_TARGET",
            "该目标当前不可操作",
          );
          return;
        }
        const previousRevision = state.revision;
        this.selectForSide(this.playerSide, target);
        this.bumpRevision();
        this.acceptAction(action.actionId, "已同步选择", state.revision);
        this.emitUpdate(previousRevision);
        return;
      }
      case "DESELECT": {
        const previousRevision = state.revision;
        this.clearSelection(this.playerSide);
        this.bumpRevision();
        this.acceptAction(action.actionId, "已取消选择", state.revision);
        this.emitUpdate(previousRevision);
        return;
      }
      case "CONFIRM": {
        const target = state.selectionTargets[this.playerSide];
        if (!target) {
          this.rejectAction(action.actionId, "INVALID_TARGET", "请先选择目标");
          return;
        }
        const previousRevision = state.revision;
        this.applyCurrentOperation(this.playerSide, target);
        this.bumpRevision();
        this.acceptAction(
          action.actionId,
          "操作已由 Mock 房主确认",
          state.revision,
        );
        this.emitUpdate(previousRevision);
        this.scheduleOpponentTurn();
        return;
      }
      case "BAN":
      case "PICK": {
        const target = action.targets[0];
        if (
          state.currentOperation !== action.kind ||
          !state.availableTargetIdsBySide[this.playerSide].includes(
            target.id,
          ) ||
          target.kind !== state.currentStep?.targetType
        ) {
          this.rejectAction(
            action.actionId,
            "INVALID_TARGET",
            "操作类型或目标不符合当前步骤",
          );
          return;
        }
        const previousRevision = state.revision;
        this.applyCurrentOperation(this.playerSide, target);
        this.bumpRevision();
        this.acceptAction(
          action.actionId,
          `${action.kind} 已确认`,
          state.revision,
        );
        this.emitUpdate(previousRevision);
        this.scheduleOpponentTurn();
        return;
      }
      case "PROTECT":
      case "BORROW":
      case "CUSTOM":
        this.rejectAction(
          action.actionId,
          "UNSUPPORTED_ACTION",
          "当前 Mock 流程未启用该扩展操作",
        );
    }
  }

  async requestState(): Promise<void> {
    await this.delay();
    if (this.state) {
      this.events.emit("bpStateReceived", this.cloneState());
    }
  }

  async requestAssets(assetIds: string[]): Promise<void> {
    for (const assetId of [...new Set(assetIds)]) {
      await this.delay(45, 120);
      const descriptor = this.manifest.assets.find(
        (asset) => asset.assetId === assetId,
      );
      if (!descriptor) {
        this.events.emit("error", {
          code: "ASSET_NOT_FOUND",
          message: `资源不存在：${assetId}`,
          recoverable: true,
        });
        continue;
      }
      this.events.emit("assetReceived", createMockAsset(descriptor));
    }
  }

  private setConnectionState(
    state: ConnectionSnapshot["state"],
    reason: string | null = null,
  ): void {
    const latencyMs =
      state === "connected"
        ? Math.round((this.minLatencyMs + this.maxLatencyMs) / 2)
        : null;
    this.snapshot = {
      state,
      transport: "mock",
      latencyMs,
      lastPingAt: state === "connected" ? new Date().toISOString() : null,
      reason,
    };
    this.events.emit("connectionStateChanged", this.snapshot);
  }

  private selectForSide(side: PlayerSide, target: BpActionTarget): void {
    if (!this.state) return;
    this.state.characters = this.state.characters.map((character) => ({
      ...character,
      selected:
        (target.kind === "CHARACTER" && character.id === target.id) ||
        (character.selected && character.selectedBy !== side),
      selectedBy:
        target.kind === "CHARACTER" && character.id === target.id
          ? side
          : character.selectedBy === side
            ? null
            : character.selectedBy,
    }));
    this.state.lightCones = this.state.lightCones.map((lightCone) => ({
      ...lightCone,
      selected:
        (target.kind === "LIGHT_CONE" && lightCone.id === target.id) ||
        (lightCone.selected && lightCone.selectedBy !== side),
      selectedBy:
        target.kind === "LIGHT_CONE" && lightCone.id === target.id
          ? side
          : lightCone.selectedBy === side
            ? null
            : lightCone.selectedBy,
    }));
    this.state.selections = { ...this.state.selections, [side]: target.id };
    this.state.selectionTargets = {
      ...this.state.selectionTargets,
      [side]: target,
    };
    this.state.canConfirm = this.state.currentActor === side;
    this.state.canConfirmBySide = {
      ...this.state.canConfirmBySide,
      [side]: this.state.currentActor === side,
    };
  }

  private clearSelection(side: PlayerSide): void {
    if (!this.state) return;
    this.state.characters = this.state.characters.map((character) =>
      character.selectedBy === side
        ? { ...character, selected: false, selectedBy: null }
        : character,
    );
    this.state.lightCones = this.state.lightCones.map((lightCone) =>
      lightCone.selectedBy === side
        ? { ...lightCone, selected: false, selectedBy: null }
        : lightCone,
    );
    this.state.selections = { ...this.state.selections, [side]: null };
    this.state.selectionTargets = {
      ...this.state.selectionTargets,
      [side]: null,
    };
    this.state.canConfirm = false;
    this.state.canConfirmBySide = {
      ...this.state.canConfirmBySide,
      [side]: false,
    };
  }

  private applyCurrentOperation(
    side: PlayerSide,
    target: BpActionTarget,
  ): void {
    const state = this.state;
    if (!state) return;
    const operation = state.currentOperation;
    const currentIndex = state.currentStep?.index ?? 1;
    const nextBans =
      operation === "BAN" && target.kind === "CHARACTER"
        ? [
            ...state.bans,
            { characterId: target.id, side, stepIndex: currentIndex },
          ]
        : state.bans;
    const nextPicks =
      operation === "PICK" && target.kind === "CHARACTER"
        ? [
            ...state.picks,
            { characterId: target.id, side, stepIndex: currentIndex },
          ]
        : state.picks;

    state.bans = nextBans;
    state.picks = nextPicks;
    if (target.kind === "LIGHT_CONE" && operation === "BAN") {
      state.lightConeBans = [
        ...state.lightConeBans,
        { lightConeId: target.id, side, stepIndex: currentIndex },
      ];
    }
    if (target.kind === "LIGHT_CONE" && operation === "PICK") {
      state.lightConePicks = [
        ...state.lightConePicks,
        { lightConeId: target.id, side, stepIndex: currentIndex },
      ];
    }
    state.characters = state.characters.map((character) =>
      target.kind === "CHARACTER" && character.id === target.id
        ? {
            ...character,
            selected: false,
            selectedBy: null,
            banned: operation === "BAN" || character.banned,
            picked: operation === "PICK" || character.picked,
            enabled: false,
          }
        : character.selectedBy === side
          ? { ...character, selected: false, selectedBy: null }
          : character,
    );
    state.lightCones = state.lightCones.map((lightCone) =>
      target.kind === "LIGHT_CONE" && lightCone.id === target.id
        ? {
            ...lightCone,
            selected: false,
            selectedBy: null,
            banned: operation === "BAN" || lightCone.banned,
            picked: operation === "PICK" || lightCone.picked,
            enabled: false,
          }
        : lightCone.selectedBy === side
          ? { ...lightCone, selected: false, selectedBy: null }
          : lightCone,
    );
    state.selections = { ...state.selections, [side]: null };
    state.selectionTargets = { ...state.selectionTargets, [side]: null };
    state.availableCharacterIds = state.characters
      .filter((character) => character.enabled)
      .map((character) => character.id);
    state.unavailableCharacterIds = state.characters
      .filter((character) => !character.enabled)
      .map((character) => character.id);
    state.availableLightConeIds = state.lightCones
      .filter((lightCone) => lightCone.enabled)
      .map((lightCone) => lightCone.id);
    state.unavailableLightConeIds = state.lightCones
      .filter((lightCone) => !lightCone.enabled)
      .map((lightCone) => lightCone.id);
    state.canConfirm = false;
    state.canConfirmBySide = { first: false, second: false };

    const nextStep = MOCK_FLOW[currentIndex];
    if (!nextStep) {
      state.status = "complete";
      state.phase = "COMPLETE";
      state.currentActor = null;
      state.currentOperation = "WAIT";
      state.currentStep = null;
      state.availableTargetIdsBySide = { first: [], second: [] };
      return;
    }

    state.phase = nextStep.operation;
    state.currentActor = nextStep.actor;
    state.currentOperation = nextStep.operation;
    state.currentStep = {
      id: `mock-step-${currentIndex + 1}`,
      index: currentIndex + 1,
      total: MOCK_FLOW.length,
      label: `第 ${currentIndex + 1} 步 · ${nextStep.actor === "first" ? "先手" : "后手"} ${nextStep.operation}`,
      targetType: nextStep.targetType,
    };
    const nextAvailableIds =
      nextStep.targetType === "CHARACTER"
        ? state.availableCharacterIds
        : state.availableLightConeIds;
    state.availableTargetIdsBySide = {
      first: nextStep.actor === "first" ? [...nextAvailableIds] : [],
      second: nextStep.actor === "second" ? [...nextAvailableIds] : [],
    };
  }

  private scheduleOpponentTurn(): void {
    const state = this.state;
    if (
      !state ||
      !this.playerSide ||
      state.status !== "running" ||
      state.currentActor === this.playerSide
    ) {
      return;
    }
    const opponent = state.currentActor;
    if (!opponent) return;

    this.schedule(() => {
      if (!this.state || this.state.currentActor !== opponent) return;
      const target = this.chooseOpponentTarget(
        this.state.currentOperation,
        opponent,
      );
      if (!target) return;
      const previousRevision = this.state.revision;
      this.selectForSide(opponent, target);
      this.bumpRevision();
      this.emitUpdate(previousRevision);

      this.schedule(() => {
        if (
          !this.state ||
          this.state.currentActor !== opponent ||
          this.state.selectionTargets[opponent]?.id !== target.id
        )
          return;
        const confirmPreviousRevision = this.state.revision;
        this.applyCurrentOperation(opponent, target);
        this.bumpRevision();
        this.emitUpdate(confirmPreviousRevision);
        this.scheduleOpponentTurn();
      }, 720);
    }, 900);
  }

  private chooseOpponentTarget(
    operation: RemoteBpOperation,
    side: PlayerSide,
  ): BpActionTarget | null {
    const state = this.state;
    const available = state?.availableTargetIdsBySide[side] ?? [];
    if (available.length === 0) return null;
    const offset = operation === "PICK" ? 2 : 0;
    const id =
      available[Math.min(offset, available.length - 1)] ?? available[0];
    if (!id || !state?.currentStep) return null;
    return { kind: state.currentStep.targetType, id } as BpActionTarget;
  }

  private bumpRevision(): void {
    if (!this.state) return;
    this.state.revision += 1;
    this.state.updatedAt = new Date().toISOString();
  }

  private emitUpdate(previousRevision: number): void {
    this.events.emit("bpStateUpdated", this.cloneState());
    if (this.snapshot.state === "connected") {
      this.snapshot = {
        ...this.snapshot,
        lastPingAt: new Date().toISOString(),
      };
      this.events.emit("connectionStateChanged", this.snapshot);
    }
    void previousRevision;
  }

  private acceptAction(
    actionId: string,
    message: string,
    appliedRevision: number,
  ): void {
    this.events.emit("actionResult", {
      actionId,
      accepted: true,
      code: "OK",
      message,
      resultingRevision: appliedRevision,
      appliedRevision,
      stateChanged: true,
    });
  }

  private rejectAction(
    actionId: string,
    code: Exclude<BpActionResult["code"], "OK">,
    message: string,
  ): void {
    this.events.emit("actionResult", {
      actionId,
      accepted: false,
      code,
      message,
      reason: message,
      resultingRevision: this.state?.revision ?? 0,
      stateChanged: false,
    });
  }

  private cloneState(): RemoteBpState {
    if (!this.state) throw new Error("Mock state is not initialized");
    return structuredClone(this.state);
  }

  private delay(
    min = this.minLatencyMs,
    max = this.maxLatencyMs,
  ): Promise<void> {
    const duration = Math.round(min + Math.random() * Math.max(0, max - min));
    return new Promise((resolve) => window.setTimeout(resolve, duration));
  }

  private schedule(callback: () => void, delayMs: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers.clear();
  }
}
