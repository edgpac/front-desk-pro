// Resolves which side of an imported WhatsApp conversation is the
// business owner, given the owner's own configured aliases (how their
// name/number appears as a WhatsApp sender label — see
// tenants.whatsapp_owner_aliases). Adapted from the reference
// implementation's core/business-identity.ts (read-only reference at
// ~/Downloads/cabos-chat, untouched by this work) — rewritten here, not
// copied, and renamed "owner" throughout (this integration's "customer
// reply" side is the tenant's own account owner, not a generic
// "business" entity).
//
// Deliberately simple: exact-string, case-insensitive matching only — no
// fuzzy matching, no phone-number normalization beyond trimming. A
// stricter match is the safer default for a feature whose entire
// purpose is correctly telling the owner's own voice apart from a
// customer's; a false negative (owner's message not recognized) just
// means less training evidence, while a false positive (a customer
// mistaken for the owner) would corrupt the whole generated profile.

import type { WhatsAppParticipantRole } from "./whatsapp-export-parser";

export type ResolveParticipantRolesResult = {
  roles: Record<string, WhatsAppParticipantRole>;
  matchedAliasCount: number;
};

function normalize(label: string): string {
  return label.trim().toLowerCase();
}

// Resolves every participant label seen in a parsed export to a role:
//  - "owner": the label exactly matches (case-insensitively, after
//    trimming) one of the tenant's configured aliases.
//  - "customer": in a 2-party conversation, the ONE OTHER label once the
//    owner's own label(s) are removed — safe to infer by elimination
//    because there is no third party to confuse it with.
//  - "unknown": in a conversation with 3+ participants (a group chat, or
//    any export where elimination can't safely pick a single
//    "customer"), every non-owner label stays unknown rather than
//    guessing which one is "the" customer.
export function resolveParticipantRoles(
  participantLabels: string[],
  ownerAliases: string[],
): ResolveParticipantRolesResult {
  const normalizedAliases = new Set(ownerAliases.map(normalize));
  const roles: Record<string, WhatsAppParticipantRole> = {};
  let matchedAliasCount = 0;

  const ownerLabels: string[] = [];
  const otherLabels: string[] = [];
  for (const label of participantLabels) {
    if (normalizedAliases.has(normalize(label))) {
      ownerLabels.push(label);
      matchedAliasCount += 1;
    } else {
      otherLabels.push(label);
    }
  }

  for (const label of ownerLabels) roles[label] = "owner";

  if (ownerLabels.length > 0 && otherLabels.length === 1) {
    // At least one label was confirmed as the owner, and exactly one
    // other participant remains — safe to infer that one is the
    // customer. Requiring a confirmed owner match first matters: with
    // zero matches, a single remaining label could be anyone (the owner
    // under an unrecognized name, the customer, or someone else) and
    // there is no anchor to eliminate it against.
    roles[otherLabels[0]!] = "customer";
  } else {
    // Zero owner matches, or 2+ non-owner participants: no safe single
    // "customer" to infer. Zero matches means no confirmed anchor; 2+
    // non-owner participants means a group chat where picking one would
    // be a guess.
    for (const label of otherLabels) roles[label] = "unknown";
  }

  return { roles, matchedAliasCount };
}
