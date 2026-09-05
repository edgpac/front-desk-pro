import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { DashboardShell } from "@/components/app/DashboardShell";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/dashboard")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Dashboard — FrontDesk" }],
  }),
  component: DashboardGate,
});

function DashboardGate() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate({ to: "/login" });
    }
  }, [loading, user, navigate]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return <DashboardShell />;
}
