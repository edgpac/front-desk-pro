import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

// Same visual weight/position as any icon-affordance input in this codebase
// (search fields, etc.) — an absolutely positioned button inside the
// field's own padding, not a separate control next to it.
const PasswordInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input type={visible ? "text" : "password"} className={cn("pr-9", className)} ref={ref} {...props} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
          tabIndex={-1}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
