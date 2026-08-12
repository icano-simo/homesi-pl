"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Table2,
  BarChart3,
  TrendingUp,
  Settings,
  Target,
  Store,
  Globe,
  ChevronDown,
  Filter,
  BookOpen,
  Percent,
  PenLine,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { useActiveBranches } from "@/components/branch-filter-provider";
import { LogoutButton } from "@/components/logout-button";

// ─── Nav tree definition ──────────────────────────────────────────────────────
// To add a top-level module: append one entry to NAV_ITEMS.
// To add a child route to a group: push to its `children` array.
type NavLeaf = { label: string; href: string; icon?: LucideIcon };
type NavGroup = { label: string; icon?: LucideIcon; children: NavLeaf[] };
type NavItem = NavLeaf | NavGroup;

const NAV_ITEMS: NavItem[] = [
  { label: "Transaction Review", href: "/transactions", icon: Table2 },
  { label: "P&L All", href: "/pl-all", icon: TrendingUp },
  { label: "P&L Notes", href: "/pl-notes", icon: MessageSquare },
  { label: "Vendors", href: "/vendors", icon: Store },
  { label: "Offshore Allocations", href: "/offshore-allocations", icon: Globe },
  { label: "Manual Entry", href: "/manual-entry", icon: PenLine },
  { label: "Loan Count", href: "/loan-count", icon: BookOpen },
  {
    label: "Cost Centers",
    icon: Target,
    children: [
      { label: "Cost Centers", href: "/cost-centers" },
      { label: "Rules", href: "/split-rules", icon: Percent },
      { label: "CC Assignment", href: "/cost-centers/conflicts" },
    ],
  },
  {
    label: "Settings",
    icon: Settings,
    children: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Upload P&L", href: "/upload" },
      { label: "GL Mapping", href: "/config/gl-mapping" },
      { label: "Branches", href: "/config/branches" },
      { label: "Branch Filter", href: "/settings", icon: Filter },
    ],
  },
];

function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}

// ─── Leaf item ────────────────────────────────────────────────────────────────

function LeafItem({
  item,
  depth = 0,
  expanded,
}: {
  item: NavLeaf;
  depth?: number;
  expanded: boolean;
}) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname.startsWith(item.href + "/");
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={[
        "flex items-center rounded-md py-2 text-sm font-medium transition-colors duration-150",
        expanded ? "gap-3 px-3" : "justify-center px-0",
        depth > 0 && expanded ? "pl-8" : "",
        active
          ? "bg-blue-600 text-white"
          : "text-slate-300 hover:bg-[#1e2d42] hover:text-white",
      ].join(" ")}
    >
      {Icon ? (
        <Icon size={16} className="shrink-0" />
      ) : (
        // Child items without icons: dot indicator (only visible when collapsed — children are
        // hidden via max-h-0 when sidebar is collapsed anyway, but kept for correctness)
        <span
          className={`shrink-0 h-1.5 w-1.5 rounded-full ${active ? "bg-white" : "bg-slate-500"}`}
        />
      )}
      <span
        className={`whitespace-nowrap overflow-hidden transition-[max-width,opacity] duration-150 leading-tight ${
          expanded ? "max-w-xs opacity-100" : "max-w-0 opacity-0"
        }`}
      >
        {item.label}
      </span>
    </Link>
  );
}

// ─── Group item ───────────────────────────────────────────────────────────────

function GroupItem({
  item,
  expanded: sidebarExpanded,
}: {
  item: NavGroup;
  expanded: boolean;
}) {
  const pathname = usePathname();
  const anyChildActive = item.children.some(
    (c) => pathname === c.href || pathname.startsWith(c.href + "/")
  );
  const [open, setOpen] = useState(anyChildActive);
  const Icon = item.icon;

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={[
          "flex w-full items-center rounded-md py-2 text-sm font-medium transition-colors duration-150",
          sidebarExpanded ? "gap-3 px-3" : "justify-center px-0",
          // When collapsed and a child is active, tint the group icon blue as an indicator
          anyChildActive && !sidebarExpanded
            ? "text-blue-400"
            : "text-slate-300 hover:bg-[#1e2d42] hover:text-white",
        ].join(" ")}
      >
        {Icon && <Icon size={16} className="shrink-0" />}
        <span
          className={`flex-1 text-left whitespace-nowrap overflow-hidden transition-[max-width,opacity] duration-150 leading-tight ${
            sidebarExpanded ? "max-w-xs opacity-100" : "max-w-0 opacity-0"
          }`}
        >
          {item.label}
        </span>
        {/* Chevron only rendered when sidebar is expanded — avoids layout shift in collapsed state */}
        {sidebarExpanded && (
          <ChevronDown
            size={14}
            className={`shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          />
        )}
      </button>

      {/* Children: max-height animation handles show/hide without layout jump */}
      <div
        className={`overflow-hidden transition-[max-height] duration-200 ease-in-out ${
          sidebarExpanded && open ? "max-h-64" : "max-h-0"
        }`}
      >
        <div className="mt-0.5 space-y-0.5">
          {item.children.map((child) => (
            <LeafItem key={child.href} item={child} depth={1} expanded={sidebarExpanded} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar shell ────────────────────────────────────────────────────────────

export function Sidebar() {
  const [expanded, setExpanded] = useState(false);
  const { activeBranches } = useActiveBranches();
  const hasFilter = activeBranches.length > 0;
  const filterLabel = activeBranches.length === 1
    ? activeBranches[0]
    : `${activeBranches.length} branches`;

  return (
    <aside
      style={{
        width: expanded ? "240px" : "68px",
        transition: "width 200ms ease-in-out",
      }}
      className="fixed left-0 top-0 h-screen z-40 flex flex-col bg-[#0f1b2d] shadow-xl overflow-hidden"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {/* Header: fixed height so the nav doesn't jump during transition */}
      <div className="relative h-[70px] shrink-0 border-b border-white/10 overflow-hidden">
        {/* Expanded — full branding */}
        <div
          className={`absolute inset-0 flex flex-col justify-center px-5 transition-opacity duration-200 ${
            expanded ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-400 whitespace-nowrap">
            Supreme Lending
          </p>
          <h1 className="mt-0.5 text-lg font-bold text-white whitespace-nowrap">
            Homesí P&amp;L
          </h1>
        </div>
        {/* Collapsed — "H" monogram */}
        <div
          className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
            expanded ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          <span className="text-xl font-bold text-blue-400">H</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 space-y-0.5 px-2">
        {NAV_ITEMS.map((item) =>
          isGroup(item) ? (
            <GroupItem key={item.label} item={item} expanded={expanded} />
          ) : (
            <LeafItem key={item.href} item={item} expanded={expanded} />
          )
        )}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 px-3 py-3 space-y-2">
        <LogoutButton expanded={expanded} />
        {/* Active branch filter indicator */}
        {hasFilter && (
          <div className="relative h-7">
            {/* Expanded: clickable text badge */}
            <Link
              href="/settings"
              className={`absolute inset-0 flex items-center gap-1.5 rounded-md bg-amber-500/20 px-2 hover:bg-amber-500/30 transition-opacity duration-200 ${
                expanded ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
              title={`Branch filter: ${activeBranches.join(", ")}`}
            >
              <Filter size={10} className="text-amber-400 shrink-0" />
              <span className="text-[11px] text-amber-300 whitespace-nowrap overflow-hidden">
                {filterLabel}
              </span>
            </Link>
            {/* Collapsed: amber dot */}
            <div
              className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
                expanded ? "opacity-0 pointer-events-none" : "opacity-100"
              }`}
            >
              <span
                className="h-2 w-2 rounded-full bg-amber-400"
                title={`Branch filter active: ${activeBranches.join(", ")}`}
              />
            </div>
          </div>
        )}
        <p
          className={`text-xs text-slate-500 whitespace-nowrap transition-opacity duration-200 ${
            expanded ? "opacity-100" : "opacity-0"
          }`}
        >
          v0.1.0
        </p>
      </div>
    </aside>
  );
}
