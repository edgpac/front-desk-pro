import { toast } from "sonner";

export async function copyText(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Couldn't copy — select the text and copy it manually.");
  }
}
