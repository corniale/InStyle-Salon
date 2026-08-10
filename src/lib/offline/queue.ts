// Offline POS write path (spec §9). Scope: recording sales, nothing else.
//
// Tickets are appended to an IndexedDB queue with a client-generated
// idempotency key and a local sequence number. A background worker drains
// the queue in order when connectivity returns; the server's unique
// constraint on idempotency_key makes replay safe. Queued tickets survive
// refresh and restart, and are never silently dropped: a ticket that fails
// validation on sync moves to a visible "needs attention" state with the
// specific reason.

import type { TicketPayload } from "@/lib/types";

const DB_NAME = "instyle-pos";
const DB_VERSION = 1;
const STORE = "ticket-queue";

export type QueuedStatus = "pending" | "syncing" | "needs_attention";

export interface QueuedTicket {
  /** idempotency key doubles as the primary key */
  key: string;
  seq: number;
  payload: TicketPayload;
  queuedAt: string;
  status: QueuedStatus;
  attempts: number;
  lastError: string | null;
  /** display fields so the queue list works fully offline */
  summary: { clientLabel: string; totalCents: number; branchId: string };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("seq", "seq", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function enqueueTicket(
  payload: TicketPayload,
  summary: QueuedTicket["summary"],
): Promise<void> {
  const all = await listQueue();
  const seq = all.length ? Math.max(...all.map((q) => q.seq)) + 1 : 1;
  const item: QueuedTicket = {
    key: payload.idempotency_key,
    seq,
    payload,
    queuedAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    lastError: null,
    summary,
  };
  await tx("readwrite", (s) => s.put(item));
  notifyQueueChanged();
}

export async function listQueue(): Promise<QueuedTicket[]> {
  const items = await tx<QueuedTicket[]>("readonly", (s) => s.getAll());
  return items.sort((a, b) => a.seq - b.seq);
}

export async function removeFromQueue(key: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(key));
  notifyQueueChanged();
}

export async function updateQueued(item: QueuedTicket): Promise<void> {
  await tx("readwrite", (s) => s.put(item));
  notifyQueueChanged();
}

// A same-tab event so the header count updates immediately; storage events
// only fire across tabs.
const QUEUE_EVENT = "instyle:queue-changed";

export function notifyQueueChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT));
  }
}

export function onQueueChanged(handler: () => void): () => void {
  window.addEventListener(QUEUE_EVENT, handler);
  return () => window.removeEventListener(QUEUE_EVENT, handler);
}
