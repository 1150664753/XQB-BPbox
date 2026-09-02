import { useAssetUrl } from "../hooks/useAssetUrl";
import type { RemoteAssetManager } from "../services/assets/RemoteAssetManager";
import type {
  PlayerSide,
  RemoteLightConeDto,
  RemoteLightConeResultEntry,
  RemoteBpResultEntry,
  RemoteCharacterDto,
} from "../types/bp";

interface ResultAvatarProps {
  entry: RemoteBpResultEntry | RemoteLightConeResultEntry;
  characters: RemoteCharacterDto[];
  lightCones: RemoteLightConeDto[];
  assetManager: RemoteAssetManager;
  kind: "ban" | "pick";
  targetType: "CHARACTER" | "LIGHT_CONE";
}

function ResultAvatar({
  entry,
  characters,
  lightCones,
  assetManager,
  kind,
  targetType,
}: ResultAvatarProps) {
  const target =
    targetType === "CHARACTER"
      ? characters.find(
          (item) => item.id === (entry as RemoteBpResultEntry).characterId,
        )
      : lightCones.find(
          (item) =>
            item.id === (entry as RemoteLightConeResultEntry).lightConeId,
        );
  const assetId =
    targetType === "CHARACTER"
      ? (target as RemoteCharacterDto | undefined)?.avatar
      : (target as RemoteLightConeDto | undefined)?.image;
  const { url } = useAssetUrl(assetManager, assetId);
  if (!target) return null;

  return (
    <div
      className={`result-avatar result-avatar--${kind}`}
      title={`${target.name} · ${kind.toUpperCase()}`}
    >
      {url ? <img src={url} alt="" /> : <span>{target.name.slice(0, 1)}</span>}
      <small>{target.name}</small>
    </div>
  );
}

interface TeamResultsProps {
  side: PlayerSide;
  name: string;
  active: boolean;
  operation: string;
  bans: Array<RemoteBpResultEntry | RemoteLightConeResultEntry>;
  picks: Array<RemoteBpResultEntry | RemoteLightConeResultEntry>;
  characters: RemoteCharacterDto[];
  lightCones: RemoteLightConeDto[];
  targetType: "CHARACTER" | "LIGHT_CONE";
  assetManager: RemoteAssetManager;
}

export function TeamResults({
  side,
  name,
  active,
  operation,
  bans,
  picks,
  characters,
  lightCones,
  targetType,
  assetManager,
}: TeamResultsProps) {
  return (
    <section
      className={`team-results team-results--${side}${active ? " team-results--active" : ""}`}
    >
      <div className="team-results__heading">
        <div className="team-mark">{side === "first" ? "先手" : "后手"}</div>
        <strong>{name}</strong>
        {active ? <span className="turn-pill">{operation}</span> : null}
      </div>
      <div className="result-line">
        <span className="result-line__label">BAN</span>
        <div className="result-line__items">
          {bans.length > 0 ? (
            bans.map((entry) => (
              <ResultAvatar
                key={`${entry.side}-${entry.stepIndex}`}
                entry={entry}
                characters={characters}
                lightCones={lightCones}
                assetManager={assetManager}
                kind="ban"
                targetType={targetType}
              />
            ))
          ) : (
            <span className="result-placeholder">—</span>
          )}
        </div>
      </div>
      <div className="result-line">
        <span className="result-line__label">PICK</span>
        <div className="result-line__items">
          {picks.length > 0 ? (
            picks.map((entry) => (
              <ResultAvatar
                key={`${entry.side}-${entry.stepIndex}`}
                entry={entry}
                characters={characters}
                lightCones={lightCones}
                assetManager={assetManager}
                kind="pick"
                targetType={targetType}
              />
            ))
          ) : (
            <span className="result-placeholder">—</span>
          )}
        </div>
      </div>
    </section>
  );
}
