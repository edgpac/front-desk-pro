import { createFileRoute } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export const Route = createFileRoute("/cookies")({
  head: () => ({
    meta: [
      { title: "Cookies Policy — Job It Ready" },
      {
        name: "description",
        content: "What cookies Job It Ready uses, and what we don't use them for.",
      },
    ],
  }),
  component: CookiesPolicy,
});

function CookiesPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="mx-auto max-w-3xl px-5 py-14">
        <p className="label-caps text-primary">Legal</p>
        <h1 className="mt-3 text-4xl">Cookies Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated October 18, 2026.</p>

        <div className="prose mt-8 max-w-none space-y-6 text-[15px] leading-relaxed text-foreground">
          <p>
            This page is intentionally short, because what we actually do with cookies is simple: we use one,
            and it isn't for tracking you.
          </p>

          <h2 className="text-xl font-semibold">The one cookie we set</h2>
          <p>
            When you're signed in and using the dashboard, we set a single cookie that remembers whether the
            sidebar navigation is collapsed or expanded, so it stays the way you left it between visits. That's
            the entire cookie footprint of this site.
          </p>

          <h2 className="text-xl font-semibold">What we don't use cookies for</h2>
          <p>
            We don't use cookies for advertising, cross-site tracking, or behavioral analytics. We don't run
            Google Analytics, Facebook Pixel, or any similar tracking script. Nothing on this site follows you
            around the web.
          </p>

          <h2 className="text-xl font-semibold">Signing in</h2>
          <p>
            Keeping you signed in to the dashboard is handled by your browser's own local storage, not a
            cookie — see our <a className="text-primary underline-offset-4 hover:underline" href="/privacy">Privacy Policy</a> for
            how that works.
          </p>

          <h2 className="text-xl font-semibold">Changes</h2>
          <p>
            If that ever changes — for example, if we add analytics down the road — we'll update this page to
            reflect it accurately, not quietly.
          </p>

          <h2 className="text-xl font-semibold">Contact</h2>
          <p>
            Questions about this policy:{" "}
            <a className="text-primary underline-offset-4 hover:underline" href="mailto:legal@frontdesk.tools">
              legal@frontdesk.tools
            </a>
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
