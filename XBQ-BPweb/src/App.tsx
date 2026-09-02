import { useEffect, useMemo } from "react";
import { useRemoteBpSession } from "./hooks/useRemoteBpSession";
import { BpPage } from "./pages/BpPage";
import { JoinPage } from "./pages/JoinPage";
import { createRemoteBpConnection } from "./services/createRemoteBpConnection";
import { MemoryAssetCache } from "./services/assets/MemoryAssetCache";
import { RemoteAssetManager } from "./services/assets/RemoteAssetManager";
import {
  RemoteBpSessionStore,
  type JoinedRoomContext,
} from "./stores/RemoteBpSessionStore";

function roomIdFromPath(pathname: string): string {
  const match = pathname.match(/^\/room\/([a-zA-Z0-9]{4,12})\/?$/);
  return match?.[1]?.toUpperCase() ?? "";
}

export default function App() {
  const services = useMemo(() => {
    const connection = createRemoteBpConnection();
    const assetManager = new RemoteAssetManager(
      connection,
      new MemoryAssetCache(),
    );
    const store = new RemoteBpSessionStore(connection);
    return { connection, assetManager, store };
  }, []);
  const session = useRemoteBpSession(services.store);
  const initialRoomId = roomIdFromPath(window.location.pathname);

  useEffect(
    () => () => {
      services.store.destroy();
      services.assetManager.destroy();
      void services.connection.disconnect();
    },
    [services],
  );

  const handleJoin = async (room: JoinedRoomContext) => {
    window.history.replaceState(null, "", `/room/${room.roomId}`);
    await services.store.join(room);
  };

  const handleLeave = async () => {
    await services.store.leave();
    window.history.replaceState(null, "", "/");
  };

  if (session.room && session.bpState) {
    return (
      <BpPage
        session={session}
        assetManager={services.assetManager}
        onSelectTarget={(kind, targetId) =>
          services.store.selectTarget(kind, targetId)
        }
        onConfirm={() => services.store.confirm()}
        onRefresh={() => services.store.refreshState()}
        onLeave={handleLeave}
      />
    );
  }

  return (
    <JoinPage
      initialRoomId={initialRoomId}
      connection={session.connection}
      message={session.feedback?.message ?? null}
      onJoin={handleJoin}
    />
  );
}
