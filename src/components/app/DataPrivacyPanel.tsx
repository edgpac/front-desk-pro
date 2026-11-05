import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import {
  deleteMyAccount,
  deleteMyCustomerData,
  type DeleteCustomerDataResult,
  type DeleteMyAccountResult,
} from "@/lib/account-deletion-server";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// Settings > Business info's "Data & Privacy" section (Phase 4A). Two
// separate destructive actions, each gated behind its own confirmation —
// never a single click: Action A needs an explicit second click inside its
// dialog, Action B additionally needs the owner to type a literal phrase,
// since it is the one of the two that cannot be undone.
export function DataPrivacyPanel() {
  const [confirmingCustomerData, setConfirmingCustomerData] = useState(false);
  const [deletingCustomerData, setDeletingCustomerData] = useState(false);

  const [confirmingAccount, setConfirmingAccount] = useState(false);
  const [deleteAccountPhrase, setDeleteAccountPhrase] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);

  async function handleDeleteCustomerData() {
    setDeletingCustomerData(true);
    try {
      const result: DeleteCustomerDataResult = await deleteMyCustomerData();
      setConfirmingCustomerData(false);
      const parts = [
        `${result.deletedLeads} lead${result.deletedLeads === 1 ? "" : "s"}`,
        `${result.deletedWhatsAppImports} WhatsApp import${result.deletedWhatsAppImports === 1 ? "" : "s"}`,
      ];
      toast.success(`Deleted ${parts.join(" and ")}.`);
      // Always stated, not just when something happens to be affected —
      // the subscriber asked what was deleted; what was deliberately kept
      // (and why) is just as much the answer to that question.
      toast.info(
        "Your WhatsApp opt-out list and communication profile were kept: opt-outs so you never " +
          "accidentally re-contact someone who asked to stop, and your communication profile " +
          "because it reflects your own writing style, not customer data.",
        { duration: 8000 },
      );
      if (result.affectedProfileVersions.length > 0) {
        toast.warning(
          `Your communication profile (version${result.affectedProfileVersions.length === 1 ? "" : "s"} ` +
            `${result.affectedProfileVersions.join(", ")}) cites messages from the WhatsApp history you just ` +
            "deleted as evidence. The profile itself was kept, but its evidence no longer exists — " +
            "consider regenerating it.",
          { duration: 8000 },
        );
      }
    } catch (err) {
      toast.error(errorMessage(err, "Could not delete your customer data. Please try again."));
    } finally {
      setDeletingCustomerData(false);
    }
  }

  async function handleDeleteAccount() {
    setDeletingAccount(true);
    try {
      const result: DeleteMyAccountResult = await deleteMyAccount();
      if (result.ok) {
        toast.success("Your account has been permanently deleted.");
        // whatsappDisconnected is false ONLY when a disconnect was
        // actually attempted and failed — never when there was nothing
        // to disconnect (that's `null`, no message needed) and never a
        // claim of success. Shown with a long duration and the redirect
        // below delayed, specifically so this is actually readable
        // instead of vanishing the instant the page navigates away.
        if (result.whatsappDisconnected === false) {
          toast.warning(
            "Your account and all its data are deleted, but WhatsApp wasn't confirmed disconnected " +
              "on Meta's side. To finish removing access, sign in to Meta's Business Settings — the " +
              "same account you used when connecting WhatsApp — and remove Job It Ready from your " +
              "connected apps or system users.",
            { duration: 15000 },
          );
        }
        await supabase.auth.signOut();
        // Give the toast(s) above time to actually be read before the
        // page navigates away — an instant redirect here would mean the
        // Meta warning above is shown and gone before anyone can read it.
        setTimeout(
          () => {
            window.location.href = "/";
          },
          result.whatsappDisconnected === false ? 6000 : 1500,
        );
      }
    } catch (err) {
      // Deliberately NOT closing the dialog or clearing the typed phrase on
      // error — these server-side error messages are specifically written
      // to say exactly what did and didn't happen (e.g. "canceling your
      // subscription failed — nothing else was changed"), and the owner
      // may want to retry immediately without retyping the phrase.
      toast.error(
        errorMessage(err, "Could not delete your account. Please try again or contact support."),
      );
    } finally {
      setDeletingAccount(false);
    }
  }

  const deletePhraseMatches = deleteAccountPhrase.trim() === "DELETE MY ACCOUNT";

  return (
    <div className="space-y-3">
      <p className="label-caps text-primary">Data &amp; Privacy</p>

      <Panel title="Data Management &amp; Account Deletion" className="border-destructive/40">
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <p className="text-sm font-semibold text-foreground">Delete all customer data</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Permanently removes every lead, customer conversation, and WhatsApp import — but
                keeps your account, business info, price sheet, WhatsApp connection, and
                subscription exactly as they are.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={() => setConfirmingCustomerData(true)}
            >
              Delete All Customer Data
            </Button>
          </div>

          <div className="border-t border-border" />

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <p className="text-sm font-semibold text-foreground">Delete my account permanently</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Cancels your subscription, disconnects WhatsApp, and permanently deletes your
                business and every record tied to it, including your login. This cannot be undone.
              </p>
            </div>
            <Button type="button" variant="destructive" onClick={() => setConfirmingAccount(true)}>
              Delete My Account Permanently
            </Button>
          </div>
        </div>
      </Panel>

      {/* Action A confirmation */}
      <AlertDialog
        open={confirmingCustomerData}
        onOpenChange={(open) => !open && !deletingCustomerData && setConfirmingCustomerData(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all customer data?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left">
                <div>
                  <p className="text-sm font-semibold text-foreground">This will delete:</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                    <li>Every lead and its estimate</li>
                    <li>Every customer conversation and message</li>
                    <li>Every WhatsApp import you've uploaded</li>
                  </ul>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">This will keep:</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                    <li>Your login and account</li>
                    <li>Your business info and price sheet</li>
                    <li>Your WhatsApp connection and subscription</li>
                    <li>
                      Your WhatsApp opt-out list — so you never accidentally re-contact someone who
                      asked to stop
                    </li>
                    <li>
                      Your communication profile, if you've built one — it reflects your own writing
                      style, not customer data (you'll be told if any of it cited a message this
                      deletes as evidence)
                    </li>
                  </ul>
                </div>
                <p className="text-sm font-semibold text-destructive">This cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingCustomerData}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteCustomerData();
              }}
              disabled={deletingCustomerData}
            >
              {deletingCustomerData && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Delete All Customer Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Action B confirmation — stronger: requires typing the exact phrase */}
      <AlertDialog
        open={confirmingAccount}
        onOpenChange={(open) => {
          if (!open && !deletingAccount) {
            setConfirmingAccount(false);
            setDeleteAccountPhrase("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete your account?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left">
                <p className="text-sm text-muted-foreground">This will, in order:</p>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  <li>Cancel your active subscription</li>
                  <li>Disconnect your WhatsApp integration</li>
                  <li>Permanently delete your business and every record tied to it</li>
                  <li>Remove your Job It Ready login entirely</li>
                </ul>
                <p className="text-sm font-semibold text-destructive">
                  This cannot be undone. Type DELETE MY ACCOUNT below to confirm.
                </p>
                <Input
                  autoFocus
                  value={deleteAccountPhrase}
                  onChange={(e) => setDeleteAccountPhrase(e.target.value)}
                  placeholder="DELETE MY ACCOUNT"
                  disabled={deletingAccount}
                  aria-label="Type DELETE MY ACCOUNT to confirm"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAccount}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteAccount();
              }}
              disabled={!deletePhraseMatches || deletingAccount}
            >
              {deletingAccount && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Delete My Account Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
