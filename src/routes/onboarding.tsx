import { createFileRoute } from "@tanstack/react-router";

import { OnboardingShell } from "@/components/app/OnboardingShell";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingShell,
});
