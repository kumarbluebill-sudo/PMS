import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Next.js needs inline scripts/styles for hydration; tighten with nonces in a later hardening pass.
const cspWith = (frameAncestors: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
// No page may be shown inside another site. The one exception below lets this site show its own invoice preview.
const csp = cspWith("'none'");
const cspSameOrigin = cspWith("'self'");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        ],
      },
      {
        // Listed after the rule above so these two headers replace its stricter ones for this path only.
        source: "/app/settings/invoice-design/preview",
        headers: [
          { key: "Content-Security-Policy", value: cspSameOrigin },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
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
