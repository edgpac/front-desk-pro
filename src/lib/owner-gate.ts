// TEMPORARY: restricts real login/signup to the site owner while Job It
// Ready is still being tested against live Meta/Stripe/Twilio integrations
// and isn't ready for real customer accounts. Marketing pages, /demo,
// /pricing, and the sample dashboard stay fully public — this only gates
// the moment someone actually authenticates (see login.tsx/signup.tsx).
// Remove once ready for real signups — see ROADMAP.md.
let warnedUnconfigured = false;

export function isOwnerEmail(email: string | null | undefined): boolean {
  const ownerEmail = import.meta.env["VITE_SITE_OWNER_EMAIL"] as string | undefined;
  if (!ownerEmail) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("[owner-gate] VITE_SITE_OWNER_EMAIL is unset — login/signup gate is disabled.");
    }
    return true; // gate disabled if no owner email is configured
  }
  return email?.toLowerCase() === ownerEmail.toLowerCase();
}
