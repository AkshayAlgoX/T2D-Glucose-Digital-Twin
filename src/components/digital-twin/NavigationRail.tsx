import React from 'react';
import { Users, User, FileText, HelpCircle, Settings } from 'lucide-react';

export function NavigationRail() {
  const items = [
    { icon: Users, id: 'cohort' },
    { icon: User, id: 'patient', active: true },
    { icon: FileText, id: 'evidence' },
    { icon: HelpCircle, id: 'help', bottom: true },
    { icon: Settings, id: 'settings', bottom: true }
  ];

  return (
    <nav className="w-[48px] border-r border-line bg-surface flex flex-col shrink-0 items-center py-4 justify-between h-full">
      <div className="flex flex-col gap-4 w-full items-center">
        {items.filter(i => !i.bottom).map(item => (
          <div key={item.id} className="relative w-full flex justify-center py-2 cursor-pointer text-ink-3 hover:text-ink transition-colors">
            {item.active && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />}
            <item.icon size={16} className={item.active ? 'text-accent' : ''} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4 w-full items-center mt-auto">
        {items.filter(i => i.bottom).map(item => (
          <div key={item.id} className="w-full flex justify-center py-2 cursor-pointer text-ink-3 hover:text-ink transition-colors">
             <item.icon size={16} />
          </div>
        ))}
      </div>
    </nav>
  );
}
