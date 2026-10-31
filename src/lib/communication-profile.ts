// The structured, per-tenant "how this business communicates" profile for
// the AI assistant integration (see the Cabos Chat × Job It Ready
// integration investigation for the full design). Deliberately generic —
// every field is optional and nothing here encodes an assumption about a
// specific industry or business. Ported from Cabos Chat's reference
// implementation (src/core/communication-profile.ts there); this is Phase 1
// of that integration — schema and pure logic only, nothing reads or
// writes it yet.
//
// Kept strictly separate from business facts: nothing in this type ever
// represents what the business offers, charges, or excludes. That remains
// price_sheet_items / tenant_capabilities / tenants, entirely untouched by
// this module. A communication profile can only ever describe tone and
// phrasing, never service availability or pricing.

// Where a field's value came from — kept distinct per field, never
// collapsed into one undifferentiated "profile" blob, so a later reader
// (a human reviewing a draft, or a future reply-drafting prompt) can tell
// an owner's own stated instruction apart from the AI's reading of the
// conversations apart from the AI's own suggestion.
export type ProfileFieldSource = "owner_stated" | "ai_observed" | "ai_suggested";

export type ProfileConfidence = "high" | "medium" | "low" | "insufficient-evidence";

export type ProfileFieldValue<T> = {
  value: T;
  source: ProfileFieldSource;
  confidence: ProfileConfidence;
  // Real conversation-message ids the value is based on — empty for an
  // owner_stated field (it came from the business's own settings, not a
  // conversation) or an ai_suggested one with no direct evidence (a
  // recommendation, not an observation). A future generator must validate
  // every cited id against real messages before trusting it — never kept
  // with a fabricated citation.
  evidence: { messageId: string }[];
};

export type CommunicationProfile = {
  businessDescription?: ProfileFieldValue<string>;
  preferredLanguages?: ProfileFieldValue<string[]>;
  toneAndStyle?: ProfileFieldValue<string>;
  greetingStyle?: ProfileFieldValue<string>;
  signOffStyle?: ProfileFieldValue<string>;
  formattingPreferences?: ProfileFieldValue<string>;
  // Typical sentence length and structure (short and direct vs. longer
  // and explanatory, simple vs. compound sentences) — distinct from
  // toneAndStyle, which covers register/formality rather than sentence
  // shape.
  sentenceStructure?: ProfileFieldValue<string>;
  serviceDescriptionApproach?: ProfileFieldValue<string>;
  pricingCommunicationRules?: ProfileFieldValue<string>;
  schedulingCommunicationRules?: ProfileFieldValue<string>;
  customerServicePrinciples?: ProfileFieldValue<string>;
  businessPoliciesAndBoundaries?: ProfileFieldValue<string>;
  // Verbatim or near-verbatim example replies worth reusing as general
  // style references for a future reply-drafting feature.
  preferredResponseExamples?: ProfileFieldValue<string[]>;
  // Recurring words/phrases/expressions actually used by the owner
  // (e.g. a characteristic greeting word, a common way of confirming a
  // booking) — distinct from preferredResponseExamples, which captures
  // whole example replies rather than individual recurring wording.
  commonPhrasesAndExpressions?: ProfileFieldValue<string[]>;
  // Claims or promises this business must never make unprompted (e.g.
  // "never guarantee a same-day appointment"). A future reply-drafting
  // prompt must check these explicitly.
  prohibitedClaims?: ProfileFieldValue<string[]>;
  // A plain string means manually/owner-authored (trusted directly, the
  // same way owner_stated fields are, since a human put it there
  // themselves) — kept for backward compatibility with profiles created
  // before evidence-backing existed and with any future manual-entry
  // caller. An AI-GENERATED general note must instead use the
  // evidence-backed ProfileFieldValue<string> shape, exactly like every
  // other field, so its claims can be checked against real owner-
  // authored messages the same way the rest of the profile already is
  // (see profile-generation-server.ts's validateGeneratedProfileEvidence)
  // — a bare string from the AI has nothing to check and is rejected
  // there. Never individually authoritative regardless of shape; see
  // formatCommunicationProfile's framing of this as additional context,
  // never a rule to obey on its own.
  generalNotes?: string | ProfileFieldValue<string>;
};

export function generalNotesText(notes: CommunicationProfile["generalNotes"]): string {
  if (notes === undefined) return "";
  return typeof notes === "string" ? notes : notes.value;
}

// Every field above, in the fixed order every formatter/differ/validator
// iterates in — adding a field means adding one entry here, not hunting
// down every place the profile is rendered or compared.
export const PROFILE_STRING_FIELDS = [
  ["businessDescription", "Business description"],
  ["toneAndStyle", "Tone and style"],
  ["greetingStyle", "Greeting style"],
  ["signOffStyle", "Sign-off style"],
  ["formattingPreferences", "Formatting preferences"],
  ["sentenceStructure", "Sentence length and structure"],
  ["serviceDescriptionApproach", "How services are described"],
  ["pricingCommunicationRules", "Pricing communication rules"],
  ["schedulingCommunicationRules", "Scheduling communication rules"],
  ["customerServicePrinciples", "Customer service principles"],
  ["businessPoliciesAndBoundaries", "Business policies and boundaries"],
] as const satisfies readonly [keyof CommunicationProfile, string][];

export const PROFILE_LIST_FIELDS = [
  ["preferredLanguages", "Preferred languages"],
  ["preferredResponseExamples", "Preferred response examples"],
  ["commonPhrasesAndExpressions", "Common phrases and expressions"],
  ["prohibitedClaims", "Prohibited claims"],
] as const satisfies readonly [keyof CommunicationProfile, string][];

export const PROFILE_FIELD_SOURCE_LABEL: Record<ProfileFieldSource, string> = {
  owner_stated: "owner-stated",
  ai_observed: "AI-observed pattern",
  ai_suggested: "AI suggestion — review before relying on this",
};

// Plain-text rendering, usable by a dashboard UI or any other future
// caller — kept here rather than duplicated inline, same reasoning as the
// reference implementation.
export function formatCommunicationProfile(profile: CommunicationProfile): string {
  const lines: string[] = [];
  for (const [key, label] of PROFILE_STRING_FIELDS) {
    const f = profile[key];
    if (!f) continue;
    lines.push(`${label}: ${f.value}`);
    lines.push(
      `  (${PROFILE_FIELD_SOURCE_LABEL[f.source]}, confidence: ${f.confidence}${f.evidence.length > 0 ? `, evidence: ${f.evidence.map((e) => `msg #${e.messageId}`).join(", ")}` : ""})`,
    );
  }
  for (const [key, label] of PROFILE_LIST_FIELDS) {
    const f = profile[key];
    if (!f) continue;
    lines.push(`${label}:`);
    for (const item of f.value) lines.push(`  - ${item}`);
    lines.push(
      `  (${PROFILE_FIELD_SOURCE_LABEL[f.source]}, confidence: ${f.confidence}${f.evidence.length > 0 ? `, evidence: ${f.evidence.map((e) => `msg #${e.messageId}`).join(", ")}` : ""})`,
    );
  }
  if (profile.generalNotes) {
    if (typeof profile.generalNotes === "string") {
      lines.push(`General notes: ${profile.generalNotes}`);
    } else {
      const f = profile.generalNotes;
      lines.push(`General notes: ${f.value}`);
      lines.push(
        `  (${PROFILE_FIELD_SOURCE_LABEL[f.source]}, confidence: ${f.confidence}${f.evidence.length > 0 ? `, evidence: ${f.evidence.map((e) => `msg #${e.messageId}`).join(", ")}` : ""})`,
      );
    }
  }
  if (lines.length === 0) return "(this profile has no fields set)";
  return lines.join("\n");
}
