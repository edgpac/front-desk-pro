import { createFileRoute, notFound } from "@tanstack/react-router";

import { BusinessDocument } from "@/components/app/BusinessDocument";
import { getLead } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/leads/$id/receipt")({
  loader: ({ params }) => {
    const lead = getLead(params.id);
    if (!lead) throw notFound();
    return lead;
  },
  component: () => <BusinessDocument kind="receipt" lead={Route.useLoaderData()} />,
});
