"use client";

// The four screen states as a hook (spec §5). Each caller gets loading /
// error / empty / populated and a retry that preserves filters. Dashboard
// tiles each use their own instance, so one failed query never blanks the
// page — partial failure is per-tile by construction.
//
// Failures retry automatically (twice, with backoff) before an error card
// ever shows. The common first-load failure is a stale auth token racing
// the queries — a tab reopened after hours fires requests before the
// background token refresh lands — so between attempts we nudge the
// session refresh. Every useQuery fetcher is a read, so retrying is safe.

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type QueryState<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "error"; data?: undefined; error: string }
  | { status: "ready"; data: T; error?: undefined };

export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
): QueryState<T> & { retry: () => void } {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });

    void (async () => {
      const attempts = 3;
      for (let i = 0; i < attempts; i++) {
        try {
          const data = await fetcherRef.current();
          if (alive) setState({ status: "ready", data });
          return;
        } catch (e: unknown) {
          if (!alive) return;
          if (i === attempts - 1) {
            setState({
              status: "error",
              error: e instanceof Error ? e.message : "The request failed.",
            });
            return;
          }
          // Refresh a possibly-expired session, then back off and retry.
          try {
            await createClient().auth.getSession();
          } catch {
            // The retry itself will surface a real auth failure.
          }
          await new Promise((r) => setTimeout(r, 700 * (i + 1)));
          if (!alive) return;
        }
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, retry };
}

/** Unwraps a Supabase response, throwing a clean message on error. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
