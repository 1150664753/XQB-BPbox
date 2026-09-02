import { useAssetUrl } from "../hooks/useAssetUrl";
import type { RemoteAssetManager } from "../services/assets/RemoteAssetManager";
import type { RemoteLightConeDto } from "../types/bp";

interface LightConeCardProps {
  lightCone: RemoteLightConeDto;
  assetManager: RemoteAssetManager;
  disabled: boolean;
  available: boolean;
  selectedByMe: boolean;
  onSelect: (lightConeId: string) => void;
}

export function LightConeCard({
  lightCone,
  assetManager,
  disabled,
  available,
  selectedByMe,
  onSelect,
}: LightConeCardProps) {
  const { url, state } = useAssetUrl(assetManager, lightCone.image);
  const status = lightCone.banned
    ? { kind: "banned", label: "BAN" }
    : lightCone.picked
      ? { kind: "picked", label: "PICK" }
      : lightCone.selected
        ? { kind: "selected", label: "已选择" }
        : null;
  const unavailable = !available;

  return (
    <button
      className={`character-card${selectedByMe ? " character-card--selected" : ""}${unavailable ? " character-card--unavailable" : ""}`}
      type="button"
      disabled={disabled}
      aria-pressed={selectedByMe}
      aria-label={`${selectedByMe ? "取消选择" : "选择"}${lightCone.name}`}
      onClick={() => onSelect(lightCone.id)}
    >
      <span className="character-card__visual light-cone-card__visual">
        {url ? (
          <img src={url} alt="" />
        ) : (
          <span className="character-card__fallback" aria-hidden="true">
            {state === "loading" ? "···" : lightCone.name.slice(0, 2)}
          </span>
        )}
        {status ? (
          <span className={`character-status character-status--${status.kind}`}>
            {status.label}
          </span>
        ) : null}
      </span>
      <span className="character-card__body">
        <strong>{lightCone.name}</strong>
        <span>{lightCone.path}</span>
      </span>
    </button>
  );
}
