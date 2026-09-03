import { useState } from "react";
import { CharacterCard } from "../components/CharacterCard";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { EnergyFlowBackground } from "../components/EnergyFlowBackground";
import { LightConeCard } from "../components/LightConeCard";
import { SelectionPanel } from "../components/SelectionPanel";
import { TeamResults } from "../components/TeamResults";
import { useAssetManagerSnapshot } from "../hooks/useAssetUrl";
import type { RemoteAssetManager } from "../services/assets/RemoteAssetManager";
import type { RemoteBpSessionSnapshot } from "../stores/RemoteBpSessionStore";
import type { RemoteBpOperation } from "../types/bp";

interface BpPageProps {
  session: RemoteBpSessionSnapshot;
  assetManager: RemoteAssetManager;
  onSelectTarget: (
    kind: "CHARACTER" | "LIGHT_CONE",
    targetId: string,
  ) => Promise<void>;
  onConfirm: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onLeave: () => Promise<void>;
}

type PromptOperation = "BAN" | "PICK" | "PROTECT" | "BORROW";

function isPromptOperation(
  operation: RemoteBpOperation,
): operation is PromptOperation {
  return ["BAN", "PICK", "PROTECT", "BORROW"].includes(operation);
}

function operationLabel(operation: RemoteBpOperation): string {
  return isPromptOperation(operation) ? operation : "WAIT";
}

export function BpPage({
  session,
  assetManager,
  onSelectTarget,
  onConfirm,
  onRefresh,
  onLeave,
}: BpPageProps) {
  const [search, setSearch] = useState("");
  const [path, setPath] = useState("全部命途");
  const [element, setElement] = useState("全部属性");
  const assetSnapshot = useAssetManagerSnapshot(assetManager);
  const state = session.bpState;
  const room = session.room;
  if (!state || !room) return null;

  const promptOperation = isPromptOperation(state.currentOperation)
    ? state.currentOperation
    : null;
  const pairedOperation =
    state.currentOperation === "PROTECT" || state.currentOperation === "BORROW";
  const displayOperation = state.waitingForHost ? "WAIT" : promptOperation;
  const playerConnection = (side: "first" | "second") => {
    if (session.connection.state === "room-closed")
      return "room-closed" as const;
    if (side === room.side && session.connection.state === "kicked")
      return "kicked" as const;
    if (side === room.side && session.connection.state === "connecting")
      return "connecting" as const;
    if (side === room.side && session.connection.state === "reconnecting")
      return "reconnecting" as const;
    if (
      side === room.side &&
      ["idle", "disconnected", "failed"].includes(session.connection.state)
    ) {
      return "disconnected" as const;
    }
    return state.playerConnections[side];
  };
  const canAct =
    state.status === "running" &&
    (pairedOperation || state.currentActor === room.side);
  const targetType =
    state.currentStep?.targetType === "LIGHT_CONE"
      ? ("LIGHT_CONE" as const)
      : ("CHARACTER" as const);
  const selectedTarget = state.selectionTargets[room.side];
  const selectedId = selectedTarget?.id ?? null;
  const selectedItem =
    selectedTarget?.kind === "LIGHT_CONE"
      ? (state.lightCones.find((item) => item.id === selectedId) ?? null)
      : (state.characters.find((item) => item.id === selectedId) ?? null);
  const activeItems =
    targetType === "LIGHT_CONE" ? state.lightCones : state.characters;
  const paths = [
    ...new Set(
      activeItems
        .map((item) => item.path)
        .filter((item): item is string => Boolean(item)),
    ),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const elements = [
    ...new Set(
      state.characters
        .map((character) => character.element)
        .filter((item): item is string => Boolean(item)),
    ),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const keyword = search.trim().toLowerCase();
  const availableIds = new Set(state.availableTargetIdsBySide[room.side]);
  const visibleCharacters = state.characters.filter((character) => {
    const matchesSearch =
      !keyword || character.name.toLowerCase().includes(keyword);
    const matchesPath = path === "全部命途" || character.path === path;
    const matchesElement =
      element === "全部属性" || character.element === element;
    return matchesSearch && matchesPath && matchesElement;
  });
  const visibleLightCones = state.lightCones.filter((lightCone) => {
    const matchesSearch =
      !keyword || lightCone.name.toLowerCase().includes(keyword);
    const matchesPath = path === "全部命途" || lightCone.path === path;
    return matchesSearch && matchesPath;
  });
  const visibleItems =
    targetType === "LIGHT_CONE" ? visibleLightCones : visibleCharacters;
  const available = visibleItems.filter((item) => availableIds.has(item.id));
  const unavailable = visibleItems.filter((item) => !availableIds.has(item.id));
  const showingLightCones = targetType === "LIGHT_CONE";
  const firstBans = (
    showingLightCones ? state.lightConeBans : state.bans
  ).filter((entry) => entry.side === "first");
  const secondBans = (
    showingLightCones ? state.lightConeBans : state.bans
  ).filter((entry) => entry.side === "second");
  const firstPicks = (
    showingLightCones ? state.lightConePicks : state.picks
  ).filter((entry) => entry.side === "first");
  const secondPicks = (
    showingLightCones ? state.lightConePicks : state.picks
  ).filter((entry) => entry.side === "second");
  const pending = Boolean(session.pendingActionId);
  const selectionLocked = pending || state.confirmedSides[room.side];
  const progressText = state.currentStep
    ? `${state.currentStep.index} / ${state.currentStep.total}`
    : "已完成";
  const progressPercent = state.currentStep
    ? Math.min(
        100,
        Math.max(0, (state.currentStep.index / state.currentStep.total) * 100),
      )
    : 100;

  return (
    <main className={`bp-page bp-page--${room.side}`}>
      <header className="bp-header">
        <a
          className="brand brand--compact"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            void onLeave();
          }}
        >
          <span className="brand__mark">X</span>
          <strong>XQBbp</strong>
        </a>
        <div className="bp-header__room">
          <span>房间</span>
          <strong>{room.roomId}</strong>
          <button
            type="button"
            onClick={() => void onRefresh()}
            title="请求最新状态"
          >
            ↻
          </button>
        </div>
        <div className="bp-header__actions">
          <div className="header-progress" title={`BP 进度 ${progressText}`}>
            <span>BP 进度</span>
            <strong>{progressText}</strong>
            <i>
              <b style={{ width: `${progressPercent}%` }} />
            </i>
          </div>
          <ConnectionBadge connection={session.connection} />
          <button
            className="ghost-button"
            type="button"
            onClick={() => void onLeave()}
          >
            离开房间
          </button>
        </div>
      </header>

      <div className="bp-content">
        <div className="bp-sticky-stack">
          <section
            className={`operation-prompt${displayOperation ? ` operation-prompt--${displayOperation.toLowerCase()}` : ""}${pairedOperation ? " operation-prompt--paired" : state.currentActor ? ` operation-prompt--${state.currentActor}` : ""}`}
            aria-live="polite"
          >
            <EnergyFlowBackground
              mode={pairedOperation ? "paired" : (state.currentActor ?? "idle")}
            />
            <strong>
              {displayOperation === "BORROW"
                ? "LOAN"
                : (displayOperation ?? "")}
            </strong>
          </section>

          <section className="teams-board panel">
            <TeamResults
              side="first"
              name={state.teams.first.name}
              active={pairedOperation || state.currentActor === "first"}
              operation={operationLabel(state.currentOperation)}
              connectionState={playerConnection("first")}
              bans={firstBans}
              picks={firstPicks}
              characters={state.characters}
              lightCones={state.lightCones}
              targetType={targetType}
              assetManager={assetManager}
            />
            <div className="versus-mark">
              <span>VS</span>
              <small>{state.flowName}</small>
            </div>
            <TeamResults
              side="second"
              name={state.teams.second.name}
              active={pairedOperation || state.currentActor === "second"}
              operation={operationLabel(state.currentOperation)}
              connectionState={playerConnection("second")}
              bans={secondBans}
              picks={secondPicks}
              characters={state.characters}
              lightCones={state.lightCones}
              targetType={targetType}
              assetManager={assetManager}
            />
          </section>
        </div>

        <section className="bp-workspace">
          <div className="roster-panel panel">
            <div className="panel-heading roster-heading">
              <h2>{showingLightCones ? "光锥池" : "角色池"}</h2>
              <div className="roster-tools">
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={showingLightCones ? "搜索光锥" : "搜索角色"}
                    aria-label={showingLightCones ? "搜索光锥" : "搜索角色"}
                  />
                </label>
                <select
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  aria-label="按命途筛选"
                >
                  <option>全部命途</option>
                  {paths.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                {!showingLightCones ? (
                  <select
                    value={element}
                    onChange={(event) => setElement(event.target.value)}
                    aria-label="按属性筛选"
                  >
                    <option>全部属性</option>
                    {elements.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>

            <div className="pool-section">
              <div className="pool-section__heading">
                <span>可操作{showingLightCones ? "光锥" : "角色"}</span>
                <small>{available.length} 个</small>
              </div>
              {available.length > 0 ? (
                <div className="character-grid">
                  {showingLightCones
                    ? visibleLightCones
                        .filter((item) => availableIds.has(item.id))
                        .map((lightCone) => (
                          <LightConeCard
                            key={lightCone.id}
                            lightCone={lightCone}
                            assetManager={assetManager}
                            available
                            disabled={!canAct || selectionLocked}
                            selectedByMe={
                              selectedTarget?.kind === "LIGHT_CONE" &&
                              selectedId === lightCone.id
                            }
                            onSelect={(id) =>
                              void onSelectTarget("LIGHT_CONE", id)
                            }
                          />
                        ))
                    : visibleCharacters
                        .filter((item) => availableIds.has(item.id))
                        .map((character) => (
                          <CharacterCard
                            key={character.id}
                            character={character}
                            assetManager={assetManager}
                            available
                            disabled={!canAct || selectionLocked}
                            selectedByMe={
                              selectedTarget?.kind === "CHARACTER" &&
                              selectedId === character.id
                            }
                            onSelect={(id) =>
                              void onSelectTarget("CHARACTER", id)
                            }
                          />
                        ))}
                </div>
              ) : (
                <div className="empty-locks">
                  没有符合筛选条件的可操作{showingLightCones ? "光锥" : "角色"}
                </div>
              )}
            </div>

            <div className="pool-section pool-section--unavailable">
              <div className="pool-section__heading">
                <span>不可操作{showingLightCones ? "光锥" : "角色"}</span>
                <small>{unavailable.length} 个</small>
              </div>
              {unavailable.length > 0 ? (
                <div className="character-grid character-grid--locked">
                  {showingLightCones
                    ? visibleLightCones
                        .filter((item) => !availableIds.has(item.id))
                        .map((lightCone) => (
                          <LightConeCard
                            key={lightCone.id}
                            lightCone={lightCone}
                            assetManager={assetManager}
                            available={false}
                            disabled
                            selectedByMe={false}
                            onSelect={() => undefined}
                          />
                        ))
                    : visibleCharacters
                        .filter((item) => !availableIds.has(item.id))
                        .map((character) => (
                          <CharacterCard
                            key={character.id}
                            character={character}
                            assetManager={assetManager}
                            available={false}
                            disabled
                            selectedByMe={false}
                            onSelect={() => undefined}
                          />
                        ))}
                </div>
              ) : (
                <div className="empty-locks">暂无不可操作目标</div>
              )}
            </div>
          </div>

          <SelectionPanel
            target={selectedItem}
            targetType={selectedTarget?.kind ?? targetType}
            assetManager={assetManager}
            actionLabel={operationLabel(state.currentOperation)}
            confirmed={state.confirmedSides[room.side]}
            canConfirm={
              canAct &&
              state.canConfirmBySide[room.side] &&
              session.connection.state === "connected"
            }
            pending={pending}
            onConfirm={() => void onConfirm()}
          />
        </section>

        <section className="system-strip" aria-live="polite">
          <span
            className={`system-strip__pulse system-strip__pulse--${session.feedback?.tone ?? "info"}`}
          />
          <strong>
            {session.feedback?.message ??
              (session.connection.state === "kicked"
                ? "已被房主踢出，连接不会自动恢复"
                : session.connection.state === "room-closed"
                  ? "房间已关闭，连接不会自动恢复"
                  : state.waitingForHost
                    ? "等待 BPbox 房主完成额外操作"
                    : state.confirmedSides[room.side]
                      ? "已确认，等待另一方确认"
                      : canAct
                        ? `轮到你操作，请选择${showingLightCones ? "光锥" : "角色"}`
                        : "等待对方与房主同步操作")}
          </strong>
          <span>
            资源 {assetSnapshot.readyCount}/{assetSnapshot.totalCount}
          </span>
          <span>版本 {state.revision}</span>
          <span>{session.connection.latencyMs ?? "—"} 毫秒</span>
        </section>
      </div>
    </main>
  );
}
