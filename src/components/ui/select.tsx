import React from 'react';
import { cn } from '@/lib/utils';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-8 w-full items-center justify-between rounded-[6px] border border-line-control bg-transparent px-3 py-1 text-[13px] leading-[20px] placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
)
Select.displayName = "Select"

export const SelectTrigger = Select;
export const SelectValue = ({ placeholder }: { placeholder?: string }) => <option value="" disabled hidden>{placeholder}</option>;
export const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const SelectItem = ({ value, children }: { value: string, children: React.ReactNode }) => <option value={value}>{children}</option>;
