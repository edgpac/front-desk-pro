import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import appCss from "../styles.css?url";

// Bump this whenever the favicon/icon files in public/ change — see the
// icon link tags below for why.
const FAVICON_VERSION = "3";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md">
        <p className="label-caps text-primary">Error 404</p>
        <h1 className="mt-3 text-4xl text-foreground">That page isn't here</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The link may be old or mistyped. Head back and try again.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md">
        <p className="label-caps text-primary">Something broke</p>
        <h1 className="mt-3 text-3xl text-foreground">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Try again, or head back home and pick up where you left off.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-sm border border-border-strong bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            Back to home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Job It Ready — instant priced estimates for trades" },
      {
        name: "description",
        content:
          "Job It Ready answers your quote requests in minutes: customers send a photo, get a priced estimate, and book straight onto your calendar.",
      },
      { property: "og:title", content: "Job It Ready — instant priced estimates for trades" },
      {
        property: "og:description",
        content: "Never miss a lead. Photo in, priced estimate out, booked job on your calendar.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      // Meta Business Manager domain-ownership verification for
      // jobitready.com — not temporary, keep this indefinitely (Meta
      // periodically re-checks it).
      { name: "facebook-domain-verification", content: "mmcl7wmuxmq3pcw3q1q7qui94sof79" },
      // Google Search Console domain-ownership verification for
      // jobitready.com — same reasoning as the Meta tag above, keep
      // indefinitely.
      { name: "google-site-verification", content: "_D8was2GSrdqJp1hMiQ16FsFWwGC2H8dbzPh-frCbdA" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap",
      },
      // Versioned query string on every icon href — browsers cache favicons
      // extremely aggressively (often ignoring normal reload behavior), so
      // this forces every browser to re-fetch after an icon update instead
      // of relying on visitors to manually clear cache. Bump FAVICON_VERSION
      // whenever these files change again.
      { rel: "icon", href: `/favicon.ico?v=${FAVICON_VERSION}`, type: "image/x-icon" },
      {
        rel: "icon",
        href: `/favicon-16x16.png?v=${FAVICON_VERSION}`,
        type: "image/png",
        sizes: "16x16",
      },
      {
        rel: "icon",
        href: `/favicon-32x32.png?v=${FAVICON_VERSION}`,
        type: "image/png",
        sizes: "32x32",
      },
      {
        rel: "apple-touch-icon",
        href: `/apple-touch-icon.png?v=${FAVICON_VERSION}`,
        sizes: "180x180",
      },
      { rel: "manifest", href: `/site.webmanifest?v=${FAVICON_VERSION}` },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster position="top-right" />
    </QueryClientProvider>
  );
}
