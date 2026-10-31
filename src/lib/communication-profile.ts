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
  serviceDescriptionApproach?: ProfileFieldValue<string>;
  pricingCommunicationRules?: ProfileFieldValue<string>;
  schedulingCommunicationRules?: ProfileFieldValue<string>;
  customerServicePrinciples?: ProfileFieldValue<string>;
  businessPoliciesAndBoundaries?: ProfileFieldValue<string>;
  // Verbatim or near-verbatim example replies worth reusing as general
  // style references for a future reply-drafting feature.
  preferredResponseExamples?: ProfileFieldValue<string[]>;
  // Claims or promises this business must never make unprompted (e.g.
  // "never guarantee a same-day appointment"). A future reply-drafting
  // prompt must check these explicitly.
  prohibitedClaims?: ProfileFieldValue<string[]>;
  // Free text only — not evidence-tracked, because it is never
  // individually authoritative; see formatCommunicationProfile's framing
  // of this as additional context, never a rule to obey on its own.
  generalNotes?: string;
};

// Every field above, in the fixed order every formatter/differ/validator
// iterates in — adding a field means adding one entry here, not hunting
// down every place the profile is rendered or compared.
export const PROFILE_STRING_FIELDS = [
  ["businessDescription", "Business description"],
  ["toneAndStyle", "Tone and style"],
  ["greetingStyle", "Greeting style"],
  ["signOffStyle", "Sign-off style"],
  ["formattingPreferences", "Formatting preferences"],
  ["serviceDescriptionApproach", "How services are described"],
  ["pricingCommunicationRules", "Pricing communication rules"],
  ["schedulingCommunicationRules", "Scheduling communication rules"],
  ["customerServicePrinciples", "Customer service principles"],
  ["businessPoliciesAndBoundaries", "Business policies and boundaries"],
] as const satisfies readonly [keyof CommunicationProfile, string][];

export const PROFILE_LIST_FIELDS = [
  ["preferredLanguages", "Preferred languages"],
  ["preferredResponseExamples", "Preferred response examples"],
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
    lines.push(`General notes: ${profile.generalNotes}`);
  }
  if (lines.length === 0) return "(this profile has no fields set)";
  return lines.join("\n");
}
