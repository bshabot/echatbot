import React, { Profiler } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Package,
  Users,
  FileText,
  Settings,
  MessageSquare,
  Calculator,
  DollarSign,
  Lightbulb,
  Hammer,
  ReceiptText,
  Pen,
  Images,
  TrendingUp,
  ClipboardList,
  Coins,
  History,
} from 'lucide-react';
import ProfileButton from './MiscComponenets/ProfileButton';
export default function Sidebar  ()  {

  const navItems = [
    // { icon: LayoutDashboard, label: 'Dashboard', to: '/' },
    { icon: Lightbulb, label: 'Ideas', to: '/ideas' },
    {icon: Pen, label: 'Design' , to: '/designs'},
    {icon: Hammer, label: 'Samples' , to: '/samples'},
    {icon: ReceiptText  , label: 'Quotes' , to: '/quotes'},
    { icon: DollarSign, label: 'Metal Prices', to: '/prices' },
    { icon: Users, label: 'Vendors', to: '/vendors' },
    { icon: Images, label: 'Images', to: '/images' },
    { icon: TrendingUp, label: 'Running Lines', to: '/running-lines' },
    { icon: ClipboardList, label: 'Purchase Orders', to: '/purchase-orders' },
    { icon: Coins, label: 'Metal Locks', to: '/metal-locks' },
    { icon: History, label: 'Import History', to: '/import-history' },
    // { icon: MessageSquare, label: 'Communications', to: '/communications' },
    // { icon: FileText, label: 'Documents', to: '/documents' },
    { icon: Settings, label: 'Settings', to: '/settings' },
  ];

  return (
    /* Mobile (<768px): 3.5rem icon-only rail via max-md: classes. Desktop untouched.
       max-md:h-dvh — 100vh lies on iOS Safari (URL bar); dvh tracks real height.
       max-md:pl-[env(...)] — respect the notch in landscape. */
    <div className="w-64 bg-white h-screen border-r border-gray-200 fixed left-0 top-0 z-30 justify-between flex flex-col max-md:w-14 max-md:h-dvh max-md:pl-[env(safe-area-inset-left)]">
      {/* Nav column scrolls on short screens (12 items > landscape phone height);
          ProfileButton stays pinned at the bottom */}
      <div className="max-md:flex-1 max-md:min-h-0 max-md:overflow-y-auto">
        <div className="p-6 max-md:p-2">
          <div className="flex flex-col items-center">
            <div className="text-[#C5A572] text-3xl font-serif tracking-wider max-md:hidden">
              E CHABOT
            </div>
            <div className="hidden max-md:block text-[#C5A572] text-lg font-serif tracking-wider">
              EC
            </div>
            <div className="text-[#C5A572] text-sm mt-1 max-md:hidden">
              EST. 1993
            </div>
          </div>
        </div>
        <nav className="mt-6">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              aria-label={item.label}
              className={({ isActive }) =>
                `flex items-center px-6 py-3 text-gray-700 hover:bg-gray-50 max-md:px-2 max-md:justify-center max-md:min-h-[44px] ${
                  isActive ? 'bg-gray-50 border-r-4 border-[#C5A572] max-md:bg-[#fdf6ec]' : ''
                }`
              }
            >
              <item.icon className="w-5 h-5 mr-3 max-md:mr-0 max-md:shrink-0" />
              <span className="max-md:hidden">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
      <ProfileButton/>
    </div>
  );
};
