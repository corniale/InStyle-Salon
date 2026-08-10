"use client";

// The pending-sync count is always visible so nobody assumes queued data is
// safe (spec §9). Counts pending + syncing + needs-attention.

import { useEffect, useState } from "react";
import { listQueue, onQueueChanged } from "./queue";
import { startSyncWorker } from "./sync";

export function usePendingSyncCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void listQueue().then((q) => {
        if (alive) setCount(q.length);
      });

    refresh();
    const offChanged = onQueueChanged(refresh);
    const stopWorker = startSyncWorker();

    return () => {
      alive = false;
      offChanged();
      stopWorker();
    };
  }, []);

  return count;
}
