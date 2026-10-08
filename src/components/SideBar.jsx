import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { NAV_SECTIONS } from './navItems';
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

        {/* Jump-to / search: opens the Ctrl+K palette */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('plm:open-palette'))}
          title="Jump to… (Ctrl+K)"
          aria-label="Jump to a page or style number"
          className={`mt-4 flex items-center text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 ${
            expanded ? 'mx-4 px-3 py-2 gap-2 w-[calc(100%-2rem)]' : 'mx-auto p-2'
          } max-md:mx-auto max-md:w-auto max-md:p-2`}
        >
          <Search className="w-4 h-4 shrink-0" />
          <span className={`text-[13px] flex-1 text-left ${expanded ? '' : 'hidden'} max-md:hidden`}>
            Jump to…
          </span>
          <kbd
            className={`text-[10px] border border-gray-200 rounded px-1 ${
              expanded ? '' : 'hidden'
            } max-md:hidden`}
          >
            Ctrl K
          </kbd>
        </button>

        <nav className="mt-3" aria-label="Main">
          {NAV_SECTIONS.map((section, si) => (
            <div key={section.name} className={si > 0 ? 'mt-2' : ''}>
              {/* Section heading when open; a hairline when collapsed/mobile */}
              <div
                className={`px-6 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 ${
                  expanded ? '' : 'hidden'
                } max-md:hidden`}
              >
                {section.name}
              </div>
              {si > 0 && (
                <div
                  className={`mx-3 border-t border-gray-100 ${
                    expanded ? 'hidden' : ''
                  } max-md:block max-md:mx-2`}
                />
              )}
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  aria-label={item.label}
                  /* The title is what makes a collapsed rail usable: hovering an
                     icon names it even before the panel finishes expanding. */
                  title={expanded ? undefined : item.label}
                  className={({ isActive }) =>
                    `flex items-center py-2.5 text-gray-700 hover:bg-gray-50 ${
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
            </div>
          ))}
        </nav>
      </div>
      <ProfileButton expanded={expanded} />
    </div>
  );
}
