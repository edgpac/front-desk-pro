import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { resolvePlanFromSubscription, PLAN_PRICE_CENTS } from "./stripe-server";

function fakeSubscription(overrides: {
  unitAmount?: number | null;
  currency?: string;
  metadataPlan?: string;
}): Stripe.Subscription {
  return {
    items: {
      data: [
        {
          price: {
            unit_amount: overrides.unitAmount ?? null,
            currency: overrides.currency ?? "usd",
          },
        },
      ],
    },
    metadata: overrides.metadataPlan ? { plan: overrides.metadataPlan } : {},
  } as unknown as Stripe.Subscription;
}

describe("resolvePlanFromSubscription", () => {
  it("resolves solo from its real configured price, ignoring metadata", () => {
    const sub = fakeSubscription({ unitAmount: PLAN_PRICE_CENTS.solo, metadataPlan: "crew" });
    // Price is the source of truth — a stale/mismatched metadata.plan never wins.
    expect(resolvePlanFromSubscription(sub)).toBe("solo");
  });

  it("resolves crew from its real configured price", () => {
    const sub = fakeSubscription({ unitAmount: PLAN_PRICE_CENTS.crew });
    expect(resolvePlanFromSubscription(sub)).toBe("crew");
  });

  it("falls back to metadata.plan when the price doesn't match either known plan", () => {
    const sub = fakeSubscription({ unitAmount: 999999, metadataPlan: "crew" });
    expect(resolvePlanFromSubscription(sub)).toBe("crew");
  });

  it("returns null when neither price nor metadata resolves to a known plan", () => {
    const sub = fakeSubscription({ unitAmount: 999999, metadataPlan: "enterprise" });
    expect(resolvePlanFromSubscription(sub)).toBeNull();
  });

  it("does not match a numerically coincident amount in a different currency", () => {
    // Same cents value as the real "solo" price, but in a currency this app
    // never actually creates subscriptions in — must fall through to
    // metadata rather than silently misreading it as a real USD plan.
    const sub = fakeSubscription({
      unitAmount: PLAN_PRICE_CENTS.solo,
      currency: "eur",
      metadataPlan: "crew",
    });
    expect(resolvePlanFromSubscription(sub)).toBe("crew");
  });

  it("falls back to metadata when currency is non-USD and metadata is also absent", () => {
    const sub = fakeSubscription({ unitAmount: PLAN_PRICE_CENTS.crew, currency: "eur" });
    expect(resolvePlanFromSubscription(sub)).toBeNull();
  });
});
