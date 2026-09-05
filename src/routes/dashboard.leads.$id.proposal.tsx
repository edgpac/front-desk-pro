import { createFileRoute } from "@tanstack/react-router";

import { BusinessDocument } from "@/components/app/BusinessDocument";
import { useLeadDocument } from "@/lib/use-lead-document";

export const Route = createFileRoute("/dashboard/leads/$id/proposal")({
  component: ProposalPage,
});

function ProposalPage() {
  const { id } = Route.useParams();
  const { lead, tenant, loading, notFound } = useLeadDocument(id);

  if (loading) return <div className="p-10 text-sm text-muted-foreground">Loading…</div>;
  if (notFound || !lead) return <div className="p-10 text-sm text-muted-foreground">Lead not found.</div>;

  return <BusinessDocument kind="proposal" lead={lead} tenant={tenant} />;
}
