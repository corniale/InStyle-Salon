"use client";

// The four screen states as a hook (spec §5). Each caller gets loading /
// error / empty / populated and a retry that preserves filters. Dashboard
// tiles each use their own instance, so one failed query never blanks the
// page — partial failure is per-tile by construction.

import { useCallback, useEffect, useRef, useState } from "react";

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
    fetcherRef
      .current()
      .then((data) => {
        if (alive) setState({ status: "ready", data });
      })
      .catch((e: unknown) => {
        if (alive)
          setState({
            status: "error",
            error: e instanceof Error ? e.message : "The request failed.",
          });
      });
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
