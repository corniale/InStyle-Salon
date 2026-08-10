import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SessionProvider } from "@/components/session-context";
import { Shell } from "@/components/shell";
import type { Branch, Profile } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: branches }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    supabase.from("branches").select("*").eq("active", true).order("code"),
  ]);

  if (!profile || !profile.active) {
    // An account with no active profile cannot use the app at all.
    await supabase.auth.signOut();
    redirect("/login");
  }

  return (
    <SessionProvider profile={profile as Profile} branches={(branches ?? []) as Branch[]}>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
