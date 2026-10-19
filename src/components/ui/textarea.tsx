import * as React from "react";

import { cn } from "../lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-xl border border-border bg-card px-3.5 py-3 text-sm text-foreground shadow-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease-smooth)] outline-none resize-y cursor-text",
          "placeholder:text-muted-foreground",
          "hover:border-border-hover",
          "focus:border-ring focus:ring-2 focus:ring-ring/20",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
