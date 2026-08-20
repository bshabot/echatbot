// src/store/SidebarStore.js
//
// Whether the sidebar is collapsed to an icon rail. Lives in a store rather
// than in Sidebar.jsx because App.jsx needs it too — the main content's left
// margin has to match the rail's width, and only one of them owns the state.
//
// Persisted, so the choice survives a reload. Hover-expansion is deliberately
// NOT in here: it's transient, belongs to the component, and (importantly)
// must not move the page content — see Sidebar.jsx.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useSidebarStore = create(
  persist(
    (set, get) => ({
      collapsed: false,
      toggleCollapsed: () => set({ collapsed: !get().collapsed }),
      setCollapsed: (collapsed) => set({ collapsed: Boolean(collapsed) }),
    }),
    { name: "plm-sidebar" }
  )
);
