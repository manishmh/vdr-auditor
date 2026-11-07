import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ["pdfjs-dist"],
  // Development-only origins allowed to load dev assets/HMR. The dev server
  // already allows `localhost`; without these entries, pages served to
  // 127.0.0.1 or the machine's LAN address render as dead static HTML (no
  // hydration, so uploads and every other interaction silently do nothing).
  // 172.20.10.4 is this machine's current LAN IP — if it changes (new
  // network/DHCP lease), replace it with the new `hostname -I` address and
  // restart `npm run dev`. Never move these into production settings;
  // production origin control stays in the Express CORS allowlist.
  allowedDevOrigins: ["127.0.0.1", "172.20.10.4"],
  async rewrites() {
    // Local development only: proxy same-origin /api/* to the Express
    // backend (npm run dev:api, default :3001) when NEXT_PUBLIC_API_BASE_URL
    // is unset. Production must never bake in this localhost target: the
    // single-project Vercel deploy leaves NEXT_PUBLIC_API_BASE_URL unset so
    // the browser calls same-origin /api/*, which vercel.json routes to the
    // api/index.js serverless function stub. The gate below keeps the dev proxy
    // out of production builds; an explicit NEXT_PUBLIC_API_BASE_URL still
    // opts a frontend into a separate backend deployment.
    if (process.env.NODE_ENV === "production") return [];
    if (process.env.NEXT_PUBLIC_API_BASE_URL) return [];
    return [{ source: "/api/:path*", destination: "http://localhost:3001/api/:path*" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
