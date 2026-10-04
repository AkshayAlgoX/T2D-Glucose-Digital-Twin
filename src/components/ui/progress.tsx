import React from 'react';
import { cn } from '@/lib/utils';

export const Progress = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { value?: number, indicatorClassName?: string }>(
  ({ className, value, indicatorClassName, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("relative h-2 w-full overflow-hidden rounded-[6px] bg-surface-2", className)}
      {...props}
    >
      <div
        className={cn("h-full w-full flex-1 bg-ink transition-all", indicatorClassName)}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </div>
  )
)
Progress.displayName = "Progress"
