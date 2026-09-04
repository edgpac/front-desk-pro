import { cn } from "@/lib/utils";
import { STATUS_LABEL, type LeadStatus } from "@/lib/mock-data";

const styles: Record<LeadStatus, string> = {
  new: "bg-primary/12 text-primary border-primary/35",
  quoted: "bg-accent/12 text-accent border-accent/35",
  booked: "bg-warn/20 text-foreground border-warn/50",
  won: "bg-success/12 text-success border-success/35",
  lost: "bg-muted text-muted-foreground border-border-strong",
};

export function StatusPill({ status, className }: { status: LeadStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-[3px] font-display text-[10px] font-bold uppercase tracking-[0.12em]",
        styles[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
