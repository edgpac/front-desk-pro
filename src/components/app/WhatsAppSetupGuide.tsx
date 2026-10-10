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
export function WhatsAppSetupGuideContent() {
  return (
    <ol className="list-decimal space-y-3 pl-5 text-sm text-foreground">
      <li>You'll log into Facebook and confirm your existing WhatsApp Business account.</li>
      <li>
        You'll be asked which Business Portfolio to share access with. If{" "}
        <span className="font-medium">"Job It Ready"</span> appears greyed out, that's expected — it's
        not a bug, it's just not yours to pick. Choose{" "}
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
  );
}
