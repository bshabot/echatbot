import {
  Settings,
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
  Link2,
} from "lucide-react";

// Single source of truth for navigation: the sidebar and the Ctrl+K palette
// both read this, so a new page is added in one place.
export const NAV_SECTIONS = [
  {
    name: "Develop",
    items: [
      { icon: Lightbulb, label: "Ideas", to: "/ideas", keywords: ["trend", "board"] },
      { icon: Pen, label: "Design", to: "/designs", keywords: ["cad", "designs"] },
      { icon: Hammer, label: "Samples", to: "/samples", keywords: ["styles", "items", "sku"] },
    ],
  },
  {
    name: "Sell",
    items: [
      { icon: ReceiptText, label: "Quotes", to: "/quotes", keywords: ["quote", "buyer"] },
      { icon: TrendingUp, label: "Running Lines", to: "/running-lines", keywords: ["banter", "catalog", "ssp"] },
      { icon: ClipboardList, label: "Sales Orders", to: "/purchase-orders", keywords: ["po", "purchase orders", "signet", "rebill"] },
    ],
  },
  {
    name: "Operations",
    items: [
      { icon: Calculator, label: "Factory Costs", to: "/factory-costs", keywords: ["cost", "pricing", "vendor"] },
      { icon: Coins, label: "Metals", to: "/prices", keywords: ["gold", "silver", "lock", "price"] },
      { icon: Tag, label: "Labels", to: "/labels", keywords: ["tags", "print"] },
      { icon: Link2, label: "Backs & Chains", to: "/components", keywords: ["components", "findings", "backs", "chains"] },
      { icon: Truck, label: "Shipments", to: "/shipments", keywords: ["ship", "tracking", "ups", "freight"] },
    ],
  },
  {
    name: "System",
    items: [{ icon: Settings, label: "Settings", to: "/settings", keywords: ["config", "quickbooks", "ssp", "options", "printer"] }],
  },
];
