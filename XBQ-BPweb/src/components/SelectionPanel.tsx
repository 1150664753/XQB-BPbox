import { useAssetUrl } from "../hooks/useAssetUrl";
import { useLayoutEffect, useRef } from "react";
import { createMessageId } from "../protocol";
import type { PreviewTiming } from "../../../shared/remoteBpDiagnostics";
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
  syncingSelection: boolean;
  onConfirm: () => void;
  previewStartedAt?: number | null;
}

export function SelectionPanel({
  target,
  targetType,
  assetManager,
  actionLabel,
  canConfirm,
  confirmed,
  pending,
  syncingSelection,
  onConfirm,
  previewStartedAt,
}: SelectionPanelProps) {
  const assetId =
    targetType === "CHARACTER"
      ? (target as RemoteCharacterDto | null)?.portrait
      : (target as RemoteLightConeDto | null)?.image;
  const { url } = useAssetUrl(assetManager, assetId);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const trace = useRef<{ value: PreviewTiming; start: number } | null>(null);
  useLayoutEffect(() => {
    const start = previewStartedAt ?? performance.now();
    const value: PreviewTiming = {
      id: createMessageId(),
      assetId: assetId ?? null,
      at: Date.now(),
      uiMs: Math.max(0, performance.now() - start),
      cached: assetManager.getState(assetId) === "ready",
      outcome: assetId ? "loading" : "no-image",
    };
    trace.current = { value, start };
    // A new intent may keep the same already-decoded DOM image; no new load event
    // will fire in that case (for example an acknowledgement/context update).
    if (
      assetId &&
      imageRef.current?.complete &&
      imageRef.current.naturalWidth > 0
    ) {
      value.outcome = "loaded";
      value.imageLoadMs = value.uiMs;
    }
    assetManager.recordPreview(value);
    return () => {
      if (value.outcome === "loading") {
        value.outcome = "superseded";
        assetManager.recordPreview({ ...value });
      }
    };
  }, [assetId, assetManager, previewStartedAt]);
  const imageFinished = (outcome: "loaded" | "failed") => {
    const current = trace.current;
    if (
      !current ||
      current.value.assetId !== assetId ||
      current.value.outcome !== "loading"
    )
      return;
    current.value.outcome = outcome;
    current.value.imageLoadMs = Math.max(0, performance.now() - current.start);
    assetManager.recordPreview({ ...current.value });
  };
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
              <img
                ref={imageRef}
                key={`${assetId}:${url}`}
                src={url}
                alt={target.name}
                onLoad={() => imageFinished("loaded")}
                onError={() => imageFinished("failed")}
              />
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
            ? syncingSelection
              ? "同步选择中…"
              : "等待房主确认…"
            : confirmed
              ? "已确认，等待另一方"
              : `确认 ${actionLabel}`}
        </span>
        <span aria-hidden="true">→</span>
      </button>
    </aside>
  );
}
