import { useAssetUrl } from "../hooks/useAssetUrl";
import type { RemoteAssetManager } from "../services/assets/RemoteAssetManager";
import type { RemoteCharacterDto, RemoteLightConeDto } from "../types/bp";

interface SelectionPanelProps {
  target: RemoteCharacterDto | RemoteLightConeDto | null;
  targetType: "CHARACTER" | "LIGHT_CONE";
  assetManager: RemoteAssetManager;
  actionLabel: string;
  canConfirm: boolean;
  confirmed: boolean;
  pending: boolean;
  onConfirm: () => void;
}

export function SelectionPanel({
  target,
  targetType,
  assetManager,
  actionLabel,
  canConfirm,
  confirmed,
  pending,
  onConfirm,
}: SelectionPanelProps) {
  const assetId =
    targetType === "CHARACTER"
      ? (target as RemoteCharacterDto | null)?.portrait
      : (target as RemoteLightConeDto | null)?.image;
  const { url } = useAssetUrl(assetManager, assetId);
  const path = target?.path ?? "";
  const element =
    targetType === "CHARACTER"
      ? (target as RemoteCharacterDto | null)?.element
      : null;

  return (
    <aside className="selection-panel panel">
      <div
        className={`selection-portrait${target ? " selection-portrait--filled" : ""}${targetType === "LIGHT_CONE" ? " selection-portrait--light-cone" : ""}`}
      >
        {target ? (
          <>
            {url ? (
              <img src={url} alt={target.name} />
            ) : (
              <span className="selection-portrait__initial">
                {target.name.slice(0, 2)}
              </span>
            )}
            <div className="selection-portrait__caption">
              {element ? <span>{element}</span> : null}
              <strong>{target.name}</strong>
              <small>{path}</small>
            </div>
          </>
        ) : (
          <div className="selection-empty">
            <span aria-hidden="true">＋</span>
            <strong>
              尚未选择{targetType === "CHARACTER" ? "角色" : "光锥"}
            </strong>
            <small>
              从{targetType === "CHARACTER" ? "角色" : "光锥"}
              池中选择一个可操作目标
            </small>
          </div>
        )}
      </div>

      <button
        className="confirm-button"
        type="button"
        disabled={!canConfirm || pending}
        onClick={onConfirm}
      >
        <span>
          {pending
            ? "等待房主确认…"
            : confirmed
              ? "已确认，等待另一方"
              : `确认 ${actionLabel}`}
        </span>
        <span aria-hidden="true">→</span>
      </button>
    </aside>
  );
}
