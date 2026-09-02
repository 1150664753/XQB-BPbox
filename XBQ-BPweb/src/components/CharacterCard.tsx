import { useAssetUrl } from "../hooks/useAssetUrl";
import type { RemoteAssetManager } from "../services/assets/RemoteAssetManager";
import type { RemoteCharacterDto } from "../types/bp";

interface CharacterCardProps {
  character: RemoteCharacterDto;
  assetManager: RemoteAssetManager;
  disabled: boolean;
  available: boolean;
  selectedByMe: boolean;
  onSelect: (characterId: string) => void;
}

function statusLabel(
  character: RemoteCharacterDto,
): { kind: "banned" | "picked" | "selected"; label: string } | null {
  if (character.banned) return { kind: "banned", label: "BAN" };
  if (character.picked) return { kind: "picked", label: "PICK" };
  if (character.selected) return { kind: "selected", label: "已选择" };
  return null;
}

export function CharacterCard({
  character,
  assetManager,
  disabled,
  available,
  selectedByMe,
  onSelect,
}: CharacterCardProps) {
  const { url, state } = useAssetUrl(assetManager, character.avatar);
  const status = statusLabel(character);
  const unavailable = !available;

  return (
    <button
      className={`character-card${selectedByMe ? " character-card--selected" : ""}${unavailable ? " character-card--unavailable" : ""}`}
      type="button"
      disabled={disabled}
      aria-pressed={selectedByMe}
      aria-label={`${selectedByMe ? "取消选择" : "选择"}${character.name}`}
      onClick={() => onSelect(character.id)}
    >
      <span className="character-card__visual">
        {url ? (
          <img src={url} alt="" />
        ) : (
          <span className="character-card__fallback" aria-hidden="true">
            {state === "loading" ? "···" : character.name.slice(0, 2)}
          </span>
        )}
        {status ? (
          <span className={`character-status character-status--${status.kind}`}>
            {status.label}
          </span>
        ) : null}
      </span>
      <span className="character-card__body">
        <strong>{character.name}</strong>
        <span>
          {character.element} · {character.path}
        </span>
      </span>
    </button>
  );
}
