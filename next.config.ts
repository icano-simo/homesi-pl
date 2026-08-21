import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["xlsx"],

  async redirects() {
    return [
      {
        // Cost Center Report was folded into P&L All, which now carries a Cost
        // Center filter with the same split-aware behaviour. Kept as a redirect
        // rather than deleted outright: the team has this URL bookmarked and in
        // shared links, and a 404 mid-week reads as "the report is gone" rather
        // than "it moved". Permanent so browsers stop re-requesting it.
        source: "/cost-center-report",
        destination: "/pl-all",
        permanent: true,
      },
      {
        // P&L All and P&L Notes became one page. They were split because a
        // reorderable hierarchy moved notes onto differently-shaped rows;
        // with four named hierarchies there is nothing to reorder, so the
        // reason is gone. Both URLs are in bookmarks and shared links, so
        // they redirect rather than 404.
        source: "/pl-all",
        destination: "/pl",
        permanent: true,
      },
      {
        source: "/pl-notes",
        destination: "/pl",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
