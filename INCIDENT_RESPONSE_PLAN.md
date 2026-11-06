# Incident Response Plan — Internal Only

First-draft procedure for what to do if something goes wrong — a security
incident, a data breach, or a privacy complaint. Same convention as
`LEGAL_REVIEW_TRACKER.md` and `SECURITY_REMEDIATION_TRACKER.md`: a plain
markdown file at the repo root, not a public-facing page, not linked from
the app.

**This is an operational first draft, not legal advice.** Notification
deadlines and requirements (who must be told, within what timeframe, under
which country's law) are genuinely unsettled — see
`LEGAL_REVIEW_TRACKER.md` item 5 and the broader audit this file came out
of. Everything below is written to be useful *today*, before that review
happens, not to replace it. Update this file once counsel has actually
weighed in on the notification-timing questions, the same way the other
two trackers get updated when their open items resolve.

Last updated: 2026-11-06.

---

## 1. What counts as an incident

Any of the following triggers this plan:

- Customer or tenant personal data (names, phone numbers, photos,
  addresses, payment info) is exposed, accessed, or modified by someone
  who shouldn't have been able to.
- A credential (Supabase service-role key, Stripe secret key, Anthropic
  API key, Meta app secret, email app password) is leaked, committed to a
  public place, or suspected compromised.
- Unauthorized access to the Supabase project, Vercel project, Stripe
  account, or Meta Business account itself (not just the app).
- A customer or tenant reports something that looks like unauthorized
  access to their own account or data.
- A vulnerability is discovered (by anyone — a researcher, a customer, an
  automated tool) that *could* have led to any of the above, even if
  nothing is confirmed exploited yet.

When in doubt, treat it as an incident and start this checklist — it's
much cheaper to stand down from a false alarm than to catch up after
treating a real one as nothing.

## 2. First hour — stop the bleeding

1. **Don't guess publicly.** Don't post, email, or tell anyone outside
   this process what happened, how bad it is, or who's affected, until
   you actually know — a wrong early guess is worse than a short delay.
2. **Contain it.** Depending on what triggered this:
   - Suspected leaked credential → rotate it immediately (Supabase
     service-role key and anon key: Project Settings → API; Stripe
     secret key: Dashboard → Developers → API keys, roll the key; Meta
     app secret: Meta App Dashboard → Settings → Basic; Anthropic key:
     console.anthropic.com → API keys). Update the corresponding env var
     in Vercel and redeploy.
   - Suspected account compromise (yours or a tenant's) → force a
     password reset / sign out all sessions for the affected account via
     Supabase Auth dashboard.
   - Suspected ongoing unauthorized access → consider pausing the
     affected Vercel deployment or Supabase project (Supabase Free tier:
     Settings → General → Pause project) if containment requires taking
     the app offline — a last resort, since this also blocks every
     tenant's legitimate traffic.
3. **Write down what you know, as you learn it**, with timestamps — what
   was checked, what was found, what was changed. This becomes both your
   internal record and, if it turns out to be needed, your evidence that
   you responded promptly and reasonably.

## 3. Assess scope

- **Supabase**: check the project's logs (Logs & Analytics in the
  dashboard) for the affected time window — auth logs for unusual
  sign-ins, Postgres logs for unusual queries, API logs for unusual
  request patterns.
- **Vercel**: check Runtime Logs and the deployment history for the
  affected window — was there a bad deploy, an exposed env var, an
  unexpected function error spike right before this was noticed?
- **Stripe**: check the Dashboard's own event log and radar/risk flags
  for anything unusual in the same window.
- **Meta**: check the WhatsApp Business Account's own activity log.
- **This app's own `audit_log` table** (service-role only, query via the
  Supabase SQL editor): `subscription.state_changed`,
  `whatsapp.connected`/`.disconnected`, and `lead.deleted` events are all
  recorded here with timestamps and actor info — a real, already-working
  source of truth for "who did what, when" within the app itself.

Answer, as concretely as you can: what data, whose, how much, for how
long, and is it still ongoing.

## 4. Who might need to be told, and when

**This section needs actual legal confirmation before you rely on it for
real deadlines** — see the open question in `LEGAL_REVIEW_TRACKER.md`.
Until that's answered, the safe default is: the more sensitive and the
more confirmed the exposure, the sooner you say something, even informally.

- **Affected tenants** (the business owners using Job It Ready) — if
  their own business data or their customers' data was exposed, they
  need to know, both because it's the right thing to do and because many
  of them will have their own notification obligations to *their*
  customers that your notice to them starts the clock on.
- **Affected end customers** (a tenant's customers, if their data was
  exposed) — normally the tenant's responsibility to notify, not Job It
  Ready's directly, but worth discussing with counsel given Job It Ready
  is the one who actually held the data.
- **US state regulators** — most US states have a breach-notification law
  with its own trigger and deadline (commonly 30-60 days from
  confirmation, some shorter); which state(s) actually apply depends on
  where affected customers are, not where the business is.
- **Mexican authority** — LFPDPPP has its own notification framework;
  which authority currently administers it post-2025-reform is itself an
  open question logged in `LEGAL_REVIEW_TRACKER.md`.
- **Stripe, Supabase, Meta, Anthropic** — if the incident involves their
  platform or credentials tied to them, their own security teams may need
  to be looped in regardless of what you decide about customer
  notification.

## 5. Preserve evidence

- Keep the logs pulled in step 3 somewhere durable (they expire on
  Vercel/Supabase's own retention windows) — export them, don't just
  screenshot.
- Keep a copy of this incident's own timeline (step 2.3) indefinitely.
- Don't delete or modify anything related to the incident until you've
  decided it's safe to — including not running the account-deletion
  feature on an affected account until you're sure you don't need its
  data for the investigation first.

## 6. After it's resolved

- Write a short internal summary: what happened, root cause, what was
  fixed, what (if anything) should change so it doesn't happen again.
- Add a dated entry to `SECURITY_REMEDIATION_TRACKER.md` if the root
  cause was a code or infrastructure issue, following its existing
  convention.
- If any notification went out, keep a copy of exactly what was sent and
  to whom, and when.

## 7. Contacts and resources (fill in / keep current)

- Supabase project: `egacwyoozhyegymbqeev` ("frontdesk")
- Vercel project: `prj_WB8q30E8APG7LYKEKtTH0MJa2N1z`
- Privacy contact already published: `jobitready@gmail.com`
- Mexican counsel: _(add once engaged)_
- US counsel: _(add once engaged)_

---

## How to use this file

Same as the other two trackers: when something here gets superseded by
actual legal guidance, or a real incident teaches something this draft
got wrong, update the relevant section with the correction and its
source, rather than silently deleting it.
