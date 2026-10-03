import React from 'react';
import { cn } from '@/lib/utils';

export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost', size?: 'default' | 'sm' | 'icon' }>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-[6px] font-medium text-[13px] leading-[20px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50",
          {
            "bg-surface-2 text-ink hover:bg-line-control": variant === 'default',
            "border border-line-control bg-transparent hover:bg-surface-2 text-ink": variant === 'outline',
            "hover:bg-surface-2 text-ink": variant === 'ghost',
            "h-8 px-4": size === 'default',
            "h-6 px-3 text-[12px] leading-[16px]": size === 'sm',
            "h-8 w-8": size === 'icon',
          },
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"
