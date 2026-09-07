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
  const sdkReady = useRef(false);

  const appId = import.meta.env["VITE_META_APP_ID"] as string | undefined;
  const configId = import.meta.env["VITE_META_CONFIG_ID"] as string | undefined;

  useEffect(() => {
    // Only load Meta's SDK once this component is actually shown and
    // configured — no reason to pull in a third-party script otherwise.
    if (!appId || sdkReady.current) return;
    sdkReady.current = true;
    void loadFacebookSdk(appId);
  }, [appId]);

  async function handleConnect() {
    if (!appId || !configId) {
      toast.error("WhatsApp connection isn't configured yet.");
      return;
    }
    setStatus("loading-sdk");
    await loadFacebookSdk(appId);

    if (!window.FB) {
      setStatus("error");
      setErrorMessage("Couldn't load Meta's connection tool. Please try again.");
      return;
    }

    setStatus("connecting");
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setStatus("idle");
          return; // user closed the popup or cancelled — not an error to surface
        }
        void (async () => {
          try {
            const result = await completeMetaWhatsAppSignup({ data: { code } });
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
        extras: { setup: {} },
      },
    );
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
        onClick={() => void handleConnect()}
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
