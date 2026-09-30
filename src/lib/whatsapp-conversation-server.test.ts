import { describe, expect, it } from "vitest";
import { decideLeadRoute } from "./whatsapp-conversation-server";

// decideLeadRoute's own doc comment documents a specific, previously
// live-confirmed defect this ordering fixes: needs_human_review once had
// its own permanently-sticky routing for every later message in the same
// 48h window, including an unrelated new request. These cases lock in the
// corrected behavior.
describe("decideLeadRoute", () => {
  it("routes to fresh_quote when there's no open lead at all", () => {
    expect(decideLeadRoute(null)).toBe("fresh_quote");
    expect(decideLeadRoute(undefined)).toBe("fresh_quote");
  });

  it("routes to continue_clarification for a lead with no confidence and no flag", () => {
    expect(decideLeadRoute({ confidence: null, flag_type: null })).toBe("continue_clarification");
  });

  it("routes to quoted_follow_up once a lead has a real confidence value", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: null })).toBe("quoted_follow_up");
  });

  it("routes a flagged, never-quoted lead (outside_service_scope) to fresh_quote", () => {
    expect(decideLeadRoute({ confidence: null, flag_type: "outside_service_scope" })).toBe("fresh_quote");
  });

  it("routes a flagged, never-quoted lead (needs_human_review) to fresh_quote — not a sticky permanent state", () => {
    expect(decideLeadRoute({ confidence: null, flag_type: "needs_human_review" })).toBe("fresh_quote");
  });

  it("confidence takes priority over flag_type: a quoted-but-flagged lead (pending_negotiated_price) still routes to quoted_follow_up", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: "pending_negotiated_price" })).toBe("quoted_follow_up");
  });

  it("confidence takes priority over flag_type even for an unrelated flag combination", () => {
    expect(decideLeadRoute({ confidence: "Low", flag_type: "needs_human_review" })).toBe("quoted_follow_up");
  });
});
