import { useEffect, useState } from "react";
import { useAuth } from "@/lib/use-auth";
import { getMyLead } from "@/lib/leads-server";
import { getMyTenant } from "@/lib/tenant-server";
import { getLead, TENANT, type Lead, type Tenant } from "@/lib/mock-data";

// Shared by the proposal/invoice/receipt routes: real lead + tenant data when
// signed in (so a document reflects whatever was actually saved on the lead
// detail page and in business settings), the matching mock lead otherwise.
export function useLeadDocument(id: string) {
  const { user, loading: authLoading } = useAuth();
  const [lead, setLead] = useState<Lead | null>(null);
  const [tenant, setTenant] = useState<Tenant>(TENANT);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const mockLead = getLead(id);
      setLead(mockLead ?? null);
      setNotFound(!mockLead);
      setTenant(TENANT);
      setLoading(false);
      return;
    }
    let active = true;
    Promise.all([getMyLead({ data: id }), getMyTenant()])
      .then(([realLead, realTenant]) => {
        if (!active) return;
        setLead(realLead);
        setTenant(realTenant);
      })
      .catch(() => {
        if (active) setNotFound(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user, id]);

  return { lead, tenant, loading, notFound };
}
