import { createFileRoute, notFound } from "@tanstack/react-router";

import { BusinessDocument } from "@/components/app/BusinessDocument";
import { getLead } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/leads/$id/invoice")({
  loader: ({ params }) => {
    const lead = getLead(params.id);
    if (!lead) throw notFound();
    return lead;
  },
  component: () => <BusinessDocument kind="invoice" lead={Route.useLoaderData()} />,
});
