import { useEffect, useState, type FormEvent } from "react";
import { ConnectionBadge } from "../components/ConnectionBadge";
import type { JoinedRoomContext } from "../stores/RemoteBpSessionStore";
import type { ConnectionSnapshot } from "../types/connection";
import type { PlayerSide } from "../types/bp";
import { runtimeConfig } from "../config/runtime";

interface JoinPageProps {
  initialRoomId: string;
  connection: ConnectionSnapshot;
  message: string | null;
  onJoin: (room: JoinedRoomContext) => Promise<void>;
}

export function JoinPage({
  initialRoomId,
  connection,
  message,
  onJoin,
}: JoinPageProps) {
  const [roomId, setRoomId] = useState(initialRoomId);
  const [displayName, setDisplayName] = useState("");
  const [side, setSide] = useState<PlayerSide>("first");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => setRoomId(initialRoomId), [initialRoomId]);

  const normalizedRoomId = roomId.trim().toUpperCase();
  const normalizedDisplayName = displayName.trim();
  const isValid =
    /^[A-Z0-9]{4,12}$/.test(normalizedRoomId) &&
    normalizedDisplayName.length >= 1 &&
    normalizedDisplayName.length <= 64;
  const joining = connection.state === "connecting";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (!isValid || joining) return;
    await onJoin({
      roomId: normalizedRoomId,
      side,
      displayName: normalizedDisplayName,
    });
  };

  return (
    <main className="join-page">
      <header className="join-header">
        <a className="brand" href="/" aria-label="XBQ BP Web 首页">
          <span className="brand__mark">X</span>
          <strong>XBQ</strong>
        </a>
        <ConnectionBadge connection={connection} />
      </header>

      <section className="join-shell">
        <div className="join-intro">
          <h1>进入远程 BP 房间</h1>
        </div>

        <form className="join-card" onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="room-id">
            房间号
          </label>
          <div
            className={`room-input${submitted && !isValid ? " room-input--error" : ""}`}
          >
            <span aria-hidden="true">#</span>
            <input
              id="room-id"
              name="roomId"
              value={roomId}
              onChange={(event) =>
                setRoomId(
                  event.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12),
                )
              }
              placeholder=""
              autoComplete="off"
              autoCapitalize="characters"
              aria-describedby="room-hint"
            />
          </div>
          <small id="room-hint" className="field-hint" />

          <label className="field-label" htmlFor="display-name">
            队伍或选手名称
          </label>
          <div className="player-name-input">
            <input
              id="display-name"
              name="displayName"
              value={displayName}
              onChange={(event) =>
                setDisplayName(event.target.value.slice(0, 64))
              }
              placeholder=""
              autoComplete="nickname"
            />
          </div>
          <small className="field-hint" />

          <fieldset className="side-selector">
            <legend className="field-label">选择身份</legend>
            <div className="side-selector__grid">
              <label
                className={`side-option side-option--first${side === "first" ? " side-option--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="side"
                  value="first"
                  checked={side === "first"}
                  onChange={() => setSide("first")}
                />
                <span className="side-option__symbol">1</span>
                <span>
                  <strong>先手</strong>
                </span>
                <i aria-hidden="true" />
              </label>
              <label
                className={`side-option side-option--second${side === "second" ? " side-option--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="side"
                  value="second"
                  checked={side === "second"}
                  onChange={() => setSide("second")}
                />
                <span className="side-option__symbol">2</span>
                <span>
                  <strong>后手</strong>
                </span>
                <i aria-hidden="true" />
              </label>
            </div>
          </fieldset>

          <button
            className="join-button"
            type="submit"
            disabled={joining || !isValid}
          >
            <span>{joining ? "正在连接房主…" : "加入房间"}</span>
            <span aria-hidden="true">→</span>
          </button>
          <div
            className={`join-message${message ? " join-message--visible" : ""}`}
            aria-live="polite"
          >
            {message ??
              `当前连接方式：${runtimeConfig.transport === "mock" ? "本地演示" : "P2P"}`}
          </div>
        </form>
      </section>
    </main>
  );
}
