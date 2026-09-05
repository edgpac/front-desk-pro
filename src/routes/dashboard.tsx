import { createFileRoute } from "@tanstack/react-router";

import { DashboardShell } from "@/components/app/DashboardShell";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard — FrontDesk" }],
  }),
  component: DashboardShell,
});
