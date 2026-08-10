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
    ];
  },
};

export default nextConfig;
