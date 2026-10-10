import { createFileRoute, Link } from "@tanstack/react-router";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { WhatsAppSetupGuideContent } from "@/components/app/WhatsAppSetupGuide";

export const Route = createFileRoute("/dashboard/whatsapp-guide")({
  component: WhatsAppGuidePage,
});

function WhatsAppGuidePage() {
  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="Settings"
        title="WhatsApp setup guide"
        description="What to expect when you connect WhatsApp via Meta — read it anytime, before or after you start."
      />

      <Panel title="What to expect">
        <WhatsAppSetupGuideContent />
      </Panel>

      <p className="text-sm text-muted-foreground">
        Ready to connect?{" "}
        <Link to="/dashboard/settings/business" className="font-semibold text-primary hover:underline">
          Go to Business settings
        </Link>
        .
      </p>
    </div>
  );
}
