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
      <img src="/logo-mark.png" alt="" className="h-8 w-8" width={32} height={32} />
      Job It Ready
    </span>
  );
}
