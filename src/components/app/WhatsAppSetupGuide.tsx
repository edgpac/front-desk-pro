import { Link } from "@tanstack/react-router";

// Shared content for the WhatsApp setup guide — used both as a standalone
// dashboard page (linked from the nav, readable anytime) and inside
// ConnectWhatsAppMeta.tsx's required confirmation dialog (so nobody can
// start the real Embedded Signup popup without having seen this). One
// source of text so the two surfaces never drift apart.
//
// Written from the exact friction points hit live on 2026-10-10: Meta's
// "Business Portfolio" terminology, "Job It Ready" appearing greyed out on
// the asset-selection screen (expected, not a bug), and the post-finish
// verification wait before messaging actually activates.
//
// Bump this whenever the data-processing paragraph below changes in a way
// that matters (a new processor, a materially different description of
// what's processed) — ConnectWhatsAppMeta.tsx sends it to
// completeMetaWhatsAppSignup, which stores it alongside the connection row
// (0026_whatsapp_connection_consent.sql) specifically so a future reader
// can tell which version of this notice a given connection acknowledged.
export const WHATSAPP_CONSENT_NOTICE_VERSION = "2026-10-19-v1";

export function WhatsAppSetupGuideContent() {
  return (
    <>
      <p className="text-sm text-foreground">
        Connecting WhatsApp through Meta lets Job It Ready send and receive WhatsApp messages —
        including photos — on your business's behalf, through Meta's WhatsApp Business Platform.
        A customer's message content and photos are sent to Anthropic's Claude API to generate an
        automated price estimate. See our{" "}
        <Link to="/privacy" className="text-primary underline-offset-4 hover:underline" target="_blank">
          Privacy Policy
        </Link>{" "}
        for the full list of providers and how this data is handled.
      </p>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm text-foreground">
        <li>You'll log into Facebook and confirm your existing WhatsApp Business account.</li>
        <li>
          You'll be asked which Business Portfolio to share access with. If{" "}
          <span className="font-medium">"Job It Ready"</span> appears greyed out, that's expected —
          it's not a bug, it's just not yours to pick. Choose{" "}
          <span className="font-medium">"Create a Business portfolio"</span> instead and fill in your
          business name, email, country, and website.
        </li>
        <li>Confirm your WhatsApp Business account name and time zone.</li>
        <li>Review the permissions Meta lists, then confirm.</li>
        <li>
          After finishing, Meta may need to verify your new Business Portfolio before messages can
          actually send or receive — you'll get an email when that's done, usually within a day. The
          connection will show as "WhatsApp connected" in Settings right away either way; the
          verification wait only affects whether messages flow yet, not whether the connection itself
          worked.
        </li>
      </ol>
    </>
  );
}
