import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

type FlatEntry =
  { kind: "header"; category: string } | { kind: "row"; service: PublicMenuServiceWithCategory };
type PublicMenuServiceWithCategory = PublicServiceMenu["services"][number];

// A category header costs more vertical room than one row (its own label
// plus top margin), and must never be the last thing packed onto a page —
// a heading with no rows under it reads as broken. ROWS_PER_PAGE is a
// deliberately conservative budget (real capacity on an 8.5x11in page at
// this row height is closer to ~30) rather than a pixel-measured one: the
// page box's own fixed Tailwind padding/typography is already known and
// fixed at build time, so a generous fixed budget is simpler and more
// robust than a runtime DOM-measurement pass (which risks SSR/hydration
// timing issues for comparatively little precision gained), and erring
// toward more, visibly-uncrowded pages is the safe direction for "keep
// everything readable."
const HEADER_UNITS = 2;
const ROW_UNITS = 1;
const ROWS_PER_PAGE = 24;

// `task` is unconstrained free text (no length limit anywhere — DB,
// server, or form), so a long task name can wrap to a second line in the
// ~600px task column. A wrapped row takes roughly double the vertical
// room a single-line row costs, which the flat ROW_UNITS budget above
// doesn't account for on its own — on screen that's harmless (the page
// box is auto-height), but print's fixed @page boundary has no such
// slack, so a page of long task names could silently overflow onto an
// unintended extra printed sheet. LONG_TASK_CHARS is a conservative,
// build-time-computable guess (not a DOM measurement, for the same
// SSR/hydration reason ROWS_PER_PAGE itself isn't pixel-measured) at
// "long enough to likely wrap" — erring toward charging more, not less,
// since an over-conservative budget just means a slightly earlier page
// break, never a missing one.
const LONG_TASK_CHARS = 70;
const WRAPPED_ROW_UNITS = 2;

function rowUnits(service: PublicMenuServiceWithCategory): number {
  return service.task.length > LONG_TASK_CHARS ? WRAPPED_ROW_UNITS : ROW_UNITS;
}

function paginate(groups: [string, PublicMenuServiceWithCategory[]][]): FlatEntry[][] {
  const flat: FlatEntry[] = [];
  for (const [category, services] of groups) {
    flat.push({ kind: "header", category });
    for (const service of services) flat.push({ kind: "row", service });
  }

  const pages: FlatEntry[][] = [];
  let current: FlatEntry[] = [];
  let currentUnits = 0;
  for (const [i, entry] of flat.entries()) {
    const units = entry.kind === "header" ? HEADER_UNITS : rowUnits(entry.service);
    // Orphan guard: don't start a category header on this page unless its
    // first row also fits — otherwise push the whole header to the next
    // page instead of stranding it alone at the bottom of this one. Looks
    // ahead at the actual next entry's cost (not a hardcoded ROW_UNITS)
    // since that first row may itself be a long, double-weighted one.
    const next = flat[i + 1];
    const nextUnits = next && next.kind === "row" ? rowUnits(next.service) : ROW_UNITS;
    const wouldOrphanHeader =
      entry.kind === "header" &&
      current.length > 0 &&
      currentUnits + units + nextUnits > ROWS_PER_PAGE;
    if (currentUnits + units > ROWS_PER_PAGE || wouldOrphanHeader) {
      if (current.length > 0) pages.push(current);
      current = [];
      currentUnits = 0;
    }
    current.push(entry);
    currentUnits += units;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function MenuPage() {
  const { slug } = Route.useParams();
  const [menu, setMenu] = useState<PublicServiceMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

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
  const pages = useMemo(() => paginate(groups), [groups]);

  // Sequential, not parallel — capturing several full-resolution (scale: 3)
  // canvases at once risks real memory pressure on longer menus, and
  // browsers can throttle or drop a burst of near-simultaneous downloads
  // triggered from one click. A short pause between each download gives
  // the browser's own download UI room to register each one individually.
  async function downloadAllPng() {
    if (!menu || pages.length === 0) return;
    setDownloading(true);
    try {
      const baseName = menu.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      for (let i = 0; i < pages.length; i++) {
        const node = pageRefs.current[i];
        if (!node) continue;
        const canvas = await html2canvas(node, {
          scale: 3,
          backgroundColor: "#ffffff",
          useCORS: true,
        });
        const link = document.createElement("a");
        const suffix = pages.length > 1 ? `-page-${i + 1}-of-${pages.length}` : "";
        link.download = `${baseName}-service-menu${suffix}.png`;
        link.href = canvas.toDataURL("image/png", 1.0);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (i < pages.length - 1) await sleep(300);
      }
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
              This business hasn't published any priced services yet — please contact them directly
              for a quote.
            </p>
          )}
        </div>
      </section>

      {!loading && !notFound && menu && pages.length > 0 && (
        <section className="bg-paper p-6 lg:p-10 print:bg-white print:p-0">
          <div className="mx-auto max-w-[8.5in]">
            <div className="mb-6 flex flex-wrap items-center justify-end gap-2 print:hidden">
              <Button
                variant="outline"
                onClick={() => void downloadAllPng()}
                disabled={downloading}
              >
                <Download className="mr-2 h-4 w-4" />
                {downloading
                  ? "Rendering…"
                  : pages.length > 1
                    ? "Download All (PNG)"
                    : "Download PNG"}
              </Button>
              <Button onClick={() => window.print()}>
                <Printer className="mr-2 h-4 w-4" /> Print / Save as PDF
              </Button>
            </div>

            {/* Unlike BusinessDocument.tsx's fixed h-[11in] w-[8.5in] box
                (an owner-facing admin tool, fine to require horizontal
                scroll on mobile), this page is customer-facing and is
                read on a phone most of the time — w-full max-w-[8.5in]
                with no forced height responsively shrinks to the
                viewport instead of overflowing it, the same pattern this
                page used before pagination. The real 8.5x11in physical
                size for Print/Save as PDF still comes entirely from the
                global @page rule in styles.css, independent of this
                box's on-screen width; print:break-after-page on every
                page except the last puts each one on its own printed
                sheet, so "Print / Save as PDF" alone already produces a
                complete multi-page PDF. "Download All" is the per-image
                equivalent for sharing pages individually (e.g. one at a
                time on WhatsApp) — html2canvas captures each box at
                whatever width it's actually rendered at, so its output
                follows the same responsive width as the screen. space-y-8
                between page boxes is screen-only styling (the print
                rule's own page break makes it irrelevant when printed). */}
            <div className="space-y-8">
              {pages.map((entries, pageIndex) => (
                <div
                  key={pageIndex}
                  ref={(node) => {
                    pageRefs.current[pageIndex] = node;
                  }}
                  className={`mx-auto flex w-full max-w-[8.5in] flex-col border border-border-strong bg-card p-8 lg:p-10 print:border-0 ${
                    pageIndex < pages.length - 1 ? "print:break-after-page" : ""
                  }`}
                >
                  <div className="border-b-2 border-ink pb-4">
                    <p className="font-display text-[22px] font-extrabold leading-tight text-foreground">
                      {menu.name}
                    </p>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      {[menu.phone, menu.email].filter(Boolean).join(" · ")}
                    </p>
                  </div>

                  {pageIndex === 0 ? (
                    <h2 className="my-6 text-center font-display text-[30px] italic tracking-wide text-foreground">
                      Services
                    </h2>
                  ) : (
                    <p className="my-4 text-center text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      Services (continued)
                    </p>
                  )}

                  <div className="flex-1 space-y-5">
                    {(() => {
                      // Within one page, consecutive "row" entries sharing
                      // the same preceding header are rendered as one
                      // <table> (so the border styling matches the original
                      // single-page layout exactly); a "header" entry
                      // starts a new group.
                      const rendered: ReactNode[] = [];
                      let currentRows: PublicMenuServiceWithCategory[] = [];
                      // A page can start mid-category (paginate() only emits
                      // one "header" entry per category, on whichever page
                      // it first appears), so if this page's first entry is
                      // a row with no header before it, seed the label from
                      // that row's own category instead of leaving it blank.
                      let currentCategory =
                        entries[0]?.kind === "row"
                          ? `${entries[0].service.category || "General"} (cont'd)`
                          : "";
                      const flushGroup = (key: string) => {
                        if (currentRows.length === 0) return;
                        rendered.push(
                          <div key={key}>
                            <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                              {currentCategory}
                            </p>
                            <table className="mt-2 w-full border-collapse">
                              <tbody>
                                {currentRows.map((service) => (
                                  <tr key={service.task} className="border-b border-border">
                                    <td className="py-2 pr-4 text-[13px] font-medium text-foreground">
                                      {service.task}
                                    </td>
                                    <td className="num py-2 text-right text-[13px] font-semibold text-foreground">
                                      {formatPrice(service, menu.currency)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>,
                        );
                        currentRows = [];
                      };
                      for (const entry of entries) {
                        if (entry.kind === "header") {
                          flushGroup(`${pageIndex}-${currentCategory}`);
                          currentCategory = entry.category;
                        } else {
                          currentRows.push(entry.service);
                        }
                      }
                      flushGroup(`${pageIndex}-${currentCategory}-last`);
                      return rendered;
                    })()}
                  </div>

                  <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-[10px] text-muted-foreground">
                    {pageIndex === pages.length - 1 ? (
                      <span>
                        Prices shown are current configured rates and may vary based on the
                        specifics of the job.
                      </span>
                    ) : (
                      <span />
                    )}
                    {pages.length > 1 && (
                      <span className="shrink-0 pl-4">
                        Page {pageIndex + 1} of {pages.length}
                      </span>
                    )}
                  </div>
                </div>
              ))}
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
