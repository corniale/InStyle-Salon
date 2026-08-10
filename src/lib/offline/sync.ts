// Drains the offline ticket queue in order (spec §9, mechanism 3-7).

import { createClient } from "@/lib/supabase/client";
import { listQueue, updateQueued, removeFromQueue, type QueuedTicket } from "./queue";

let draining = false;

/** Errors that mean "the ticket itself is bad" rather than "try again later".
    These move the ticket to needs-attention instead of retrying forever. */
function isValidationError(code: string | undefined, message: string): boolean {
  if (!code) return false;
  // 23xxx integrity, 22xxx data, 42501 RLS, P0001 raised exceptions from our
  // guards (closed day, package exhausted, inactive technician, ...).
  return (
    code.startsWith("23") ||
    code.startsWith("22") ||
    code === "42501" ||
    code === "P0001" ||
    /violates|not allowed|no longer|closed|expired|required/i.test(message)
  );
}

export async function drainQueue(): Promise<void> {
  if (draining || typeof navigator === "undefined" || !navigator.onLine) return;
  draining = true;
  try {
    const supabase = createClient();
    const queue = await listQueue();

    // Strictly in order: a later ticket never jumps an earlier one, so the
    // server sees the same sequence the branch actually rang up.
    for (const item of queue) {
      if (item.status === "needs_attention") continue;

      const syncing: QueuedTicket = { ...item, status: "syncing", attempts: item.attempts + 1 };
      await updateQueued(syncing);

      const { error } = await supabase.rpc("create_ticket", { p_payload: item.payload });

      if (!error) {
        // Success — includes the duplicate-replay case, which the RPC
        // reports as success (mechanism 4).
        await removeFromQueue(item.key);
        continue;
      }

      if (isValidationError(error.code, error.message)) {
        // Visible, with the specific reason. Never discarded (mechanism 7).
        await updateQueued({ ...syncing, status: "needs_attention", lastError: error.message });
        continue;
      }

      // Network or transient server trouble: put it back and stop draining;
      // order must hold, so nothing behind it goes either.
      await updateQueued({ ...syncing, status: "pending", lastError: error.message });
      break;
    }
  } finally {
    draining = false;
  }
}

/** Wire up automatic drains: on regained connectivity and on an interval. */
export function startSyncWorker(): () => void {
  const onOnline = () => void drainQueue();
  window.addEventListener("online", onOnline);
  const interval = window.setInterval(() => void drainQueue(), 30_000);
  void drainQueue();
  return () => {
    window.removeEventListener("online", onOnline);
    window.clearInterval(interval);
  };
}
