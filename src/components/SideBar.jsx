import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Package,
  FileText,
  Settings,
  MessageSquare,
  Calculator,
  Lightbulb,
  Hammer,
  ReceiptText,
  Pen,
  TrendingUp,
  ClipboardList,
  Coins,
  Truck,
  Tag,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import ProfileButton from './MiscComponenets/ProfileButton';
import { useSidebarStore } from '../store/SidebarStore';

export default function Sidebar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const [hovered, setHovered] = useState(false);

  // Collapsed = a 3.5rem icon rail. Hovering it shows the full sidebar
  // again, WITHOUT pushing the page: the expanded state is an overlay on top
  // of the content (App.jsx keeps its margin at the rail width). Expanding
  // in-flow would reflow every table under the cursor on a mouse-over, which
  // is worse than the crowding it's meant to solve.
  const expanded = !collapsed || hovered;

  const navItems = [
    // { icon: LayoutDashboard, label: 'Dashboard', to: '/' },
    { icon: Lightbulb, label: 'Ideas', to: '/ideas' },
    { icon: Pen, label: 'Design', to: '/designs' },
    { icon: Hammer, label: 'Samples', to: '/samples' },
    { icon: ReceiptText, label: 'Quotes', to: '/quotes' },
    { icon: Coins, label: 'Metals', to: '/prices' },
    { icon: TrendingUp, label: 'Running Lines', to: '/running-lines' },
    { icon: ClipboardList, label: 'Sales Orders', to: '/purchase-orders' },
    { icon: Calculator, label: 'Factory Costs', to: '/factory-costs' },
    { icon: Tag, label: 'Labels', to: '/labels' },
    { icon: Truck, label: 'Shipments', to: '/shipments' },
    // { icon: MessageSquare, label: 'Communications', to: '/communications' },
    // { icon: FileText, label: 'Documents', to: '/documents' },
    { icon: Settings, label: 'Settings', to: '/settings' },
  ];

  return (
    /* Mobile (<768px): 3.5rem icon-only rail via max-md: classes, unchanged —
       the collapse control is desktop-only (there's no hover on touch, so a
       rail you can't expand by hovering would be a trap).
       max-md:h-dvh — 100vh lies on iOS Safari (URL bar); dvh tracks real height.
       max-md:pl-[env(...)] — respect the notch in landscape. */
    <div
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`${expanded ? 'w-64' : 'w-16'} ${
        collapsed && hovered ? 'shadow-xl' : ''
      } bg-white h-screen border-r border-gray-200 fixed left-0 top-0 z-30 justify-between flex flex-col transition-[width] duration-200 ease-out max-md:w-14 max-md:h-dvh max-md:pl-[env(safe-area-inset-left)]`}
    >
      {/* Nav column scrolls on short screens (12 items > landscape phone height);
          ProfileButton stays pinned at the bottom */}
      <div className="max-md:flex-1 max-md:min-h-0 max-md:overflow-y-auto">
        <div className={`${expanded ? 'p-6' : 'p-3'} max-md:p-2 relative`}>
          <div className="flex flex-col items-center">
            <div
              className={`text-[#C5A572] font-serif tracking-wider max-md:hidden ${
                expanded ? 'text-3xl' : 'text-lg'
              }`}
            >
              {expanded ? 'E CHABOT' : 'EC'}
            </div>
            <div className="hidden max-md:block text-[#C5A572] text-lg font-serif tracking-wider">
              EC
            </div>
            {expanded && (
              <div className="text-[#C5A572] text-sm mt-1 max-md:hidden">EST. 1993</div>
            )}
          </div>

          {/* Pin / unpin. Only meaningful on desktop, hence max-md:hidden. */}
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? 'Keep sidebar open' : 'Collapse sidebar to icons'}
            aria-label={collapsed ? 'Keep sidebar open' : 'Collapse sidebar to icons'}
            className={`absolute top-2 right-2 p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 max-md:hidden ${
              collapsed && !hovered ? 'opacity-0 pointer-events-none' : 'opacity-100'
            } transition-opacity`}
          >
            {collapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav className="mt-6">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              aria-label={item.label}
              /* The title is what makes a collapsed rail usable: hovering an
                 icon names it even before the panel finishes expanding. */
              title={expanded ? undefined : item.label}
              className={({ isActive }) =>
                `flex items-center py-3 text-gray-700 hover:bg-gray-50 ${
                  expanded ? 'px-6' : 'px-0 justify-center'
                } max-md:px-2 max-md:justify-center max-md:min-h-[44px] ${
                  isActive
                    ? 'bg-gray-50 border-r-4 border-[#C5A572] max-md:bg-[#fdf6ec]'
                    : ''
                }`
              }
            >
              <item.icon
                className={`w-5 h-5 shrink-0 ${expanded ? 'mr-3' : 'mr-0'} max-md:mr-0`}
              />
              <span className={`whitespace-nowrap ${expanded ? '' : 'hidden'} max-md:hidden`}>
                {item.label}
              </span>
            </NavLink>
          ))}
        </nav>
      </div>
      <ProfileButton expanded={expanded} />
    </div>
  );
}
