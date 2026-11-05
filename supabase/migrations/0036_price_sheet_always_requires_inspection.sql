-- Per-row, business-configured flag: this service must NEVER receive an
-- instant price from a photo/description alone, no matter how confident the
-- AI is — always defer to an in-person look (or that row's own diagnosis
-- fee, if one is configured) instead.
--
-- 0016_price_sheet_ai_notes.sql's own comment deliberately chose free text
-- over a structured flag for exactly this case ("always needs an in-person
-- look before quoting, don't estimate from a photo alone"), reasoning that
-- "a business-specific operating quirk for one service rarely generalizes
-- into a checkbox every other business would also need." A real production
-- incident has since shown that reasoning doesn't hold for this specific
-- quirk: it's common across many kinds of service businesses (anything
-- priced per area/condition/scope that can't be judged from a photo — paint
-- coverage, concrete repair extent, flooring, roofing, etc.), and —
-- critically — a free-text ai_notes instruction has NO code-level
-- enforcement (see estimate-server.ts's buildPrompt, which only ever reads
-- ai_notes into the prompt as advisory text): nothing stops the AI from
-- quoting a price anyway if it doesn't comply, which is exactly what
-- happened. ai_notes remains for genuinely business-specific free-text
-- guidance that isn't about this one enforceable behavior; this column is
-- specifically for the one case that's both common enough to generalize
-- and high-stakes enough to need a real guarantee, not just a prompt hope.
--
-- Default false matches every existing row's current, unchanged behavior —
-- no existing tenant's estimates change because this migration is applied.
-- Safe to re-run.

alter table public.price_sheet_items
  add column if not exists always_requires_inspection boolean not null default false;
