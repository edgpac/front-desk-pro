import { describe, expect, it } from "vitest";
import { resolveParticipantRoles } from "./whatsapp-owner-identity";

describe("resolveParticipantRoles", () => {
  it("resolves a simple 2-party conversation: owner by alias, customer by elimination", () => {
    const { roles, matchedAliasCount } = resolveParticipantRoles(
      ["Jane Owner", "Bob Customer"],
      ["Jane Owner"],
    );
    expect(roles).toEqual({ "Jane Owner": "owner", "Bob Customer": "customer" });
    expect(matchedAliasCount).toBe(1);
  });

  it("matches an alias case-insensitively and after trimming", () => {
    const { roles } = resolveParticipantRoles(["jane owner", "Bob Customer"], ["  Jane Owner  "]);
    expect(roles["jane owner"]).toBe("owner");
    expect(roles["Bob Customer"]).toBe("customer");
  });

  it("matches a phone-number-style alias exactly, with no normalization", () => {
    const { roles } = resolveParticipantRoles(["+1 555-0100", "Bob Customer"], ["+1 555-0100"]);
    expect(roles["+1 555-0100"]).toBe("owner");
  });

  it("does NOT match a differently-formatted phone number — exact-string only, no fuzzy matching", () => {
    const { roles, matchedAliasCount } = resolveParticipantRoles(
      ["15550100", "Bob Customer"],
      ["+1 555-0100"],
    );
    expect(roles["15550100"]).toBe("unknown");
    expect(matchedAliasCount).toBe(0);
  });

  it("leaves every participant unknown in a group chat with 2+ non-owner participants — never guesses which one is the customer", () => {
    const { roles } = resolveParticipantRoles(["Jane Owner", "Bob", "Alice"], ["Jane Owner"]);
    expect(roles["Bob"]).toBe("unknown");
    expect(roles["Alice"]).toBe("unknown");
  });

  it("resolves everyone to unknown when no alias matches at all (misconfigured or empty identity)", () => {
    const { roles, matchedAliasCount } = resolveParticipantRoles(
      ["Jane Owner", "Bob Customer"],
      [],
    );
    expect(roles).toEqual({ "Jane Owner": "unknown", "Bob Customer": "unknown" });
    expect(matchedAliasCount).toBe(0);
  });

  it("leaves a single remaining participant unknown (not customer) when zero owner aliases matched and only one label exists", () => {
    // Only one participant at all, and it does NOT match any alias — it
    // must not be inferred as "customer" by elimination, since there is
    // no owner-recognized side to eliminate it against.
    const { roles } = resolveParticipantRoles(["Mystery Person"], ["Jane Owner"]);
    expect(roles["Mystery Person"]).toBe("unknown");
  });

  it("handles a conversation where every participant is a recognized owner alias (no customer at all)", () => {
    const { roles } = resolveParticipantRoles(
      ["Jane Owner", "Jane's Other Number"],
      ["Jane Owner", "Jane's Other Number"],
    );
    expect(roles).toEqual({ "Jane Owner": "owner", "Jane's Other Number": "owner" });
  });

  it("returns an empty roles map for an empty participant list", () => {
    const { roles, matchedAliasCount } = resolveParticipantRoles([], ["Jane Owner"]);
    expect(roles).toEqual({});
    expect(matchedAliasCount).toBe(0);
  });
});
