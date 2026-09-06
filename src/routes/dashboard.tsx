import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { DashboardShell } from "@/components/app/DashboardShell";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/dashboard")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Dashboard — Job It Ready" }],
  }),
  component: DashboardGate,
});

// No login required — this is sample data (see DashboardShell's banner),
// so prospects can poke around before signing up, the same way /demo works.
// Nothing in here costs money or calls a real backend except the Stripe
// checkout button, which is independently protected server-side by
// requireSupabaseAuth regardless of whether this page is gated.
function DashboardGate() {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return <DashboardShell />;
}
