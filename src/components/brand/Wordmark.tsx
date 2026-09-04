import { cn } from "@/lib/utils";

export function Wordmark({ className, tone = "ink" }: { className?: string; tone?: "ink" | "light" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-display text-[17px] font-extrabold tracking-[-0.03em]",
        tone === "light" ? "text-ink-foreground" : "text-foreground",
        className,
      )}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-primary text-[13px] font-extrabold text-primary-foreground">
        F
      </span>
      FrontDesk
    </span>
  );
}
