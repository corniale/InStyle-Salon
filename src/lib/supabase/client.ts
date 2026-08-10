import { createBrowserClient } from "@supabase/ssr";

// The anon key ships in the bundle by design; RLS is the control (spec §8.3).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
