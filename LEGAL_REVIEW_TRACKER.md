# Legal Review Tracker — Internal Only

Dated, authoritative log of open legal questions on the draft public-facing
policy documents (`src/routes/privacy.tsx`, `terms.tsx`, `refund-policy.tsx`,
`cookies.tsx`, `community-standards.tsx`). **Not a public-facing page, not
linked from the app, and not part of the routed application** — a plain
markdown file at the repo root, same convention as
`SECURITY_REMEDIATION_TRACKER.md`.

**Nothing in this file is a legal conclusion.** Every item below is an open
question for qualified Mexican (and, where relevant, US) legal counsel —
engineering/documentation work can describe what the code actually does, but
cannot determine what the law requires. Do not treat any item here as
resolved until counsel has actually weighed in.

Last updated: 2026-11-04.

---

## Open items

### 1. Terms of Service — Texas governing-law clause
`terms.tsx`'s "Governing law" section currently states the Terms are
governed by the laws of the State of Texas. No Texas nexus (entity,
address, operations) was found anywhere in this codebase, ROADMAP.md, or
project configuration during this session's audits — every signal points
to the operator being based in Mexico. **Not changed** per explicit
instruction pending review. Question for counsel: is this clause
intentional, inherited template boilerplate, or should it name a different
governing law given the operator's actual location and the Mexico-based
sole-proprietorship structure?

### 2. Privacy Policy — does the operator's legal name need to appear here?
The operator's legal name (Edgardo P. Marrero) currently appears only in
the site footer, added specifically to satisfy a documented Meta Business
Verification rejection (see this session's own prior research — real
rejection-then-approval evidence on this exact account, not speculation).
The Privacy Policy and Terms of Service don't name the operator anywhere.
Question for counsel: does a Mexican privacy notice (aviso de privacidad)
need to separately identify the responsable (controller) by legal name
within the notice itself, distinct from the Meta-driven footer disclosure?

### 3. Mexican ARCO rights and privacy-notice format
No ARCO-rights (Acceso, Rectificación, Cancelación, Oposición) language
exists anywhere in the current Privacy Policy draft, despite the policy
covering data from Mexican end customers (and, in many cases, Mexican
business-account holders) as a matter of fact. A 2025 legal reform to
Mexico's data-protection framework was found during this session's
research, with genuine uncertainty flagged about which authority currently
administers LFPDPPP post-reform — this needs direct verification against
current official sources, not assumed from pre-reform guidance. Question
for counsel: is ARCO-rights language a mandatory inclusion for this
privacy notice today, and in what specific form (the "simplificado"
condensed format referenced in earlier research, or something else)?

### 4. International data-transfer disclosure
Supabase, Stripe, Anthropic, Meta, and (as of this stage's correction)
Google are all foreign (US)-hosted infrastructure that routinely receives
personal data originating from Mexican end customers and business-account
holders. No disclosure of this cross-border transfer currently exists in
the Privacy Policy. Question for counsel: is an explicit international-
transfer disclosure (and/or consent mechanism) legally required here, and
if so, what must it say?

### 5. Additional Mexican consumer-protection disclosures
Beyond the Article 76 Bis subscription-billing provisions already
investigated separately (Stage 1B — advance renewal notice, express
consent, disclosure of recurring charges), question for counsel: are there
other Federal Consumer Protection Law (LFPC) disclosure requirements
specific to this business's actual model (AI-generated estimates,
cross-border B2B SaaS subscription, WhatsApp-based customer communication)
that haven't been identified in this session's research?

---

## How to use this file

When counsel resolves an item, update its entry with the resolution and
the source/basis for it (a specific statute citation, an attorney's
written guidance, etc.) — don't just delete the entry. Move resolved items
to a dated "Resolved" section below this line rather than removing the
history, matching `SECURITY_REMEDIATION_TRACKER.md`'s own convention.
