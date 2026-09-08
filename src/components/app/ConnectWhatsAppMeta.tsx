import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { completeMetaWhatsAppSignup } from "@/lib/meta-whatsapp-server";

// Meta Embedded Signup — Stage 2B only. This component's entire job is:
// load Meta's JS SDK, trigger FB.login() with the Embedded Signup
// configuration, get back a short-lived authorization code, and hand that
// code to completeMetaWhatsAppSignup. It never sees a WABA id, phone
// number id, or access token — those are resolved and stored server-side.
//
// NOTE: cannot be exercised end-to-end without a real Meta Developer App
// (VITE_META_APP_ID/VITE_META_CONFIG_ID) — the FB SDK load and FB.login()
// call below follow Meta's currently-documented Embedded Signup pattern,
// but should be confirmed against a real popup flow during Stage 2B's own
// live verification.

declare global {
  interface Window {
    FB?: {
      init: (params: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
        options: {
          config_id: string;
          response_type: "code";
          override_default_response_type: true;
          extras?: { setup?: Record<string, unknown>; sessionInfoVersion?: string };
        },
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const GRAPH_VERSION_FOR_SDK = "v26.0";
const FB_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

function loadFacebookSdk(appId: string): Promise<void> {
  return new Promise((resolve) => {
    if (window.FB) {
      resolve();
      return;
    }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION_FOR_SDK });
      resolve();
    };
    if (document.getElementById("facebook-jssdk")) return;
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  });
}

type Status = "idle" | "loading-sdk" | "connecting" | "connected" | "error";

export function ConnectWhatsAppMeta() {
  const [status, setStatus] = useState<Status>("idle");
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const sdkLoadTriggered = useRef(false);
  const capturedRedirectUri = useRef<string | null>(null);
  const capturedWabaId = useRef<string | null>(null);
  const capturedPhoneNumberId = useRef<string | null>(null);

  const appId = import.meta.env["VITE_META_APP_ID"] as string | undefined;
  const configId = import.meta.env["VITE_META_CONFIG_ID"] as string | undefined;

  useEffect(() => {
    // Load Meta's SDK as soon as this component mounts — not on click.
    // FB.login() opens a popup via window.open(), which browsers only allow
    // as the direct, synchronous result of a user gesture. Awaiting the SDK
    // load inside the click handler puts a microtask between the click and
    // FB.login(), which some browsers then treat as an unsolicited popup
    // and block silently (no exception, no callback, nothing visible).
    // Preloading here means the click handler below can call FB.login()
    // synchronously once the SDK is already present.
    if (!appId || sdkLoadTriggered.current) return;
    sdkLoadTriggered.current = true;
    void loadFacebookSdk(appId);
  }, [appId]);

  useEffect(() => {
    // Meta binds the authorization code FB.login() returns to the exact
    // redirect_uri its popup used to open — a dynamic
    // https://staticxx.facebook.com/x/connect/xd_arbiter/... URL, unique
    // per attempt, that Meta's own JS SDK generates internally and never
    // exposes through the FB.login() callback's response object. The
    // server-side exchange fails with error_subcode=36008 ("redirect_uri
    // isn't identical") unless this exact value is echoed back — confirmed
    // via live A/B testing against an isolated diagnostic page. FB.login()
    // opens this popup via window.open(), so intercepting that call here is
    // the only way to observe the real value; the popup itself still opens
    // normally, this only reads the URL passed to it.
    const nativeOpen = window.open;
    window.open = function (url?: string | URL, target?: string, features?: string) {
      if (typeof url === "string" && url.includes("facebook.com") && url.includes("dialog/oauth")) {
        try {
          const redirectUri = new URL(url).searchParams.get("redirect_uri");
          if (redirectUri) capturedRedirectUri.current = redirectUri;
        } catch {
          // Malformed URL from the SDK — leave capturedRedirectUri as-is;
          // handleConnect's own check below catches a missing value.
        }
      }
      return nativeOpen.call(window, url, target, features);
    };
    return () => {
      window.open = nativeOpen;
    };
  }, []);

  useEffect(() => {
    // Meta's Embedded Signup popup posts a WA_EMBEDDED_SIGNUP message back
    // to this window as the WABA/phone-number flow completes, carrying the
    // real waba_id/phone_number_id it granted — enabled by
    // sessionInfoVersion on the FB.login() call below. debug_token's
    // granular_scopes never reflected a WABA-scoped grant for this app's
    // configuration despite the configuration itself being set up
    // correctly, so the server validates these captured ids directly
    // against Meta using the exchanged token, rather than trying to
    // discover them from the token alone.
    function handleMessage(event: MessageEvent) {
      if (typeof event.origin !== "string" || !event.origin.endsWith("facebook.com")) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return; // not a JSON message we care about
      }
      if (data && typeof data === "object" && (data as { type?: unknown }).type === "WA_EMBEDDED_SIGNUP") {
        const payload = (data as { data?: { waba_id?: string; phone_number_id?: string } }).data;
        if (payload?.waba_id) capturedWabaId.current = payload.waba_id;
        if (payload?.phone_number_id) capturedPhoneNumberId.current = payload.phone_number_id;
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  function handleConnect() {
    if (!appId || !configId) {
      toast.error("WhatsApp connection isn't configured yet.");
      return;
    }

    if (!window.FB) {
      // Not ready yet — do not await-load-then-call here, since that would
      // reintroduce the same async gap this fix removes. Let the user retry
      // once the (already in-flight, from mount) SDK load has finished.
      toast.error("Still loading Meta's connection tool — please try again in a moment.");
      return;
    }

    // reset before this attempt's popup opens
    capturedRedirectUri.current = null;
    capturedWabaId.current = null;
    capturedPhoneNumberId.current = null;
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setStatus("idle");
          return; // user closed the popup or cancelled — not an error to surface
        }
        const redirectUri = capturedRedirectUri.current;
        const wabaId = capturedWabaId.current;
        const phoneNumberId = capturedPhoneNumberId.current;
        if (!redirectUri || !wabaId || !phoneNumberId) {
          setStatus("error");
          setErrorMessage(
            "Couldn't complete the WhatsApp connection — no WhatsApp Business Account was selected. Please try again.",
          );
          return;
        }
        void (async () => {
          try {
            const result = await completeMetaWhatsAppSignup({ data: { code, redirectUri, wabaId, phoneNumberId } });
            if (result.status === "connected") {
              setStatus("connected");
              setDisplayPhoneNumber(result.displayPhoneNumber);
              toast.success("WhatsApp connected.");
            } else {
              setStatus("error");
              setErrorMessage(result.message);
            }
          } catch (err) {
            setStatus("error");
            setErrorMessage(err instanceof Error ? err.message : "Couldn't complete the WhatsApp connection.");
          }
        })();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" },
      },
    );
    setStatus("connecting");
  }

  if (status === "connected" && displayPhoneNumber) {
    return (
      <div className="rounded-sm border border-border-strong bg-muted px-4 py-3">
        <p className="text-sm font-medium text-foreground">WhatsApp connected</p>
        <p className="text-xs text-muted-foreground">{displayPhoneNumber}</p>
      </div>
    );
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        onClick={handleConnect}
        disabled={status === "loading-sdk" || status === "connecting" || !appId || !configId}
      >
        {status === "connecting" ? "Connecting…" : "Connect WhatsApp via Meta"}
      </Button>
      {status === "error" && errorMessage && (
        <p className="mt-2 text-xs text-destructive">{errorMessage}</p>
      )}
    </div>
  );
}
