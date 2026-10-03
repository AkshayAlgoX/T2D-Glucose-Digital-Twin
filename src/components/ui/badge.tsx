import React from 'react';
import { cn } from '@/lib/utils';

export const Badge = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'secondary' | 'destructive' | 'outline' }>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "inline-flex items-center rounded-[6px] px-2 py-0.5 text-[11px] leading-[16px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-accent",
          {
            "bg-surface-2 text-ink": variant === 'default',
            "bg-surface text-ink-2": variant === 'secondary',
            "bg-alert-bg text-alert-ink border border-alert-edge": variant === 'destructive',
            "text-ink border border-line-control": variant === 'outline',
          },
          className
        )}
        {...props}
      />
    )
  }
)
Badge.displayName = "Badge"
