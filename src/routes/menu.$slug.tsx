import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import html2canvas from "html2canvas-pro";
import { Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/mock-data";
import { getPublicServiceMenu, type PublicServiceMenu } from "@/lib/service-menu-server";

export const Route = createFileRoute("/menu/$slug")({
  head: () => ({
    meta: [
      { title: "Service menu" },
      { name: "description", content: "A customer-friendly list of services and prices." },
    ],
  }),
  component: MenuPage,
});

function groupByCategory(services: PublicServiceMenu["services"]) {
  const groups = new Map<string, PublicServiceMenu["services"]>();
  for (const service of services) {
    const key = service.category || "General";
    const existing = groups.get(key);
    if (existing) existing.push(service);
    else groups.set(key, [service]);
  }
  return Array.from(groups.entries());
}

function MenuPage() {
  const { slug } = Route.useParams();
  const [menu, setMenu] = useState<PublicServiceMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const documentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    getPublicServiceMenu({ data: slug })
      .then((realMenu) => {
        if (active) setMenu(realMenu);
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
  }, [slug]);

  const groups = useMemo(() => (menu ? groupByCategory(menu.services) : []), [menu]);

  async function downloadPng() {
    if (!documentRef.current || !menu) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(documentRef.current, {
        scale: 3,
        backgroundColor: "#ffffff",
        useCORS: true,
      });
      const link = document.createElement("a");
      link.download = `${menu.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-service-menu.png`;
      link.href = canvas.toDataURL("image/png", 1.0);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error("Service menu PNG export failed:", err);
      toast.error("Couldn't generate the PNG — try Print / Save as PDF instead.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="print:hidden">
        <SiteHeader />
      </div>

      <section className="border-b border-border-strong bg-paper print:hidden">
        <div className="mx-auto max-w-3xl px-5 py-12">
          <p className="label-caps text-primary">Service menu</p>
          <h1 className="mt-3 text-4xl sm:text-5xl">
            {loading ? "Loading…" : notFound ? "Service menu unavailable" : menu?.name}
          </h1>
          {notFound && (
            <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
              This service menu isn't available right now — please contact the business directly.
            </p>
          )}
          {!loading && !notFound && menu && groups.length === 0 && (
            <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
              This business hasn't published any priced services yet — please contact them directly for a quote.
            </p>
          )}
        </div>
      </section>

      {!loading && !notFound && menu && groups.length > 0 && (
        <section className="bg-paper p-6 lg:p-10 print:bg-white print:p-0">
          <div className="mx-auto max-w-[8.5in]">
            <div className="mb-6 flex flex-wrap items-center justify-end gap-2 print:hidden">
              <Button variant="outline" onClick={() => void downloadPng()} disabled={downloading}>
                <Download className="mr-2 h-4 w-4" /> {downloading ? "Rendering…" : "Download PNG"}
              </Button>
              <Button onClick={() => window.print()}>
                <Printer className="mr-2 h-4 w-4" /> Print / Save as PDF
              </Button>
            </div>

            <div
              ref={documentRef}
              className="mx-auto w-full max-w-[8.5in] border border-border-strong bg-card p-8 lg:p-10 print:border-0"
            >
              <div className="border-b-2 border-ink pb-4">
                <p className="font-display text-[22px] font-extrabold leading-tight text-foreground">{menu.name}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {[menu.phone, menu.email].filter(Boolean).join(" · ")}
                </p>
              </div>

              <h2 className="my-6 text-center font-display text-[30px] italic tracking-wide text-foreground">
                Services
              </h2>

              <div className="space-y-6">
                {groups.map(([category, services]) => (
                  <div key={category}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                      {category}
                    </p>
                    <table className="mt-2 w-full border-collapse">
                      <tbody>
                        {services.map((service) => (
                          <tr key={service.task} className="border-b border-border">
                            <td className="py-2 pr-4 text-[13px] font-medium text-foreground">{service.task}</td>
                            <td className="num py-2 text-right text-[13px] font-semibold text-foreground">
                              {formatPrice(service, menu.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              <p className="mt-8 border-t border-border pt-3 text-[10px] text-muted-foreground">
                Prices shown are current configured rates and may vary based on the specifics of the job.
              </p>
            </div>
          </div>
        </section>
      )}

      <div className="print:hidden">
        <SiteFooter />
      </div>
    </div>
  );
}
