import { useEffect, useState } from "react";
import { getMyWhatsAppConnection, type MyWhatsAppConnection } from "@/lib/meta-whatsapp-server";
import { cn } from "@/lib/utils";

// A small always-visible signal on the dashboard's Today page so a broken
// WhatsApp connection is never something the owner only discovers by
// noticing leads have quietly stopped arriving. Complements the email alert
// in notify-server.ts's sendConnectionFailedNotificationEmail — this is the
// in-app half of the same "don't fail silently" fix; the email is the part
// that reaches them even when they're not looking at the dashboard.
export function WhatsAppStatusLight() {
  const [connection, setConnection] = useState<MyWhatsAppConnection | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    getMyWhatsAppConnection()
      .then((result) => {
        if (active) setConnection(result);
      })
      .catch(() => {
        // Silent on purpose — a failed status check shouldn't itself show
        // as an error banner on the dashboard's home page.
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!loaded || !connection || connection.status === "disconnected") return null;

  const isOnline = connection.status === "online";
  const isFailed = connection.status === "failed";

  if (!isOnline && !isFailed) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-sm border px-3 py-2 text-sm",
        isOnline
          ? "border-success/35 bg-success/12 text-success"
          : "border-destructive/35 bg-destructive/12 text-destructive",
      )}
    >
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", isOnline ? "bg-success" : "bg-destructive")}
        aria-hidden
      />
      {isOnline ? (
        <span>
          WhatsApp connected
          {connection.displayPhoneNumber ? ` — ${connection.displayPhoneNumber}` : ""}
        </span>
      ) : (
        <span>
          Your WhatsApp connection needs attention — check your email (including your spam/junk folder)
          for details on what happened and how to reconnect.
        </span>
      )}
    </div>
  );
}
