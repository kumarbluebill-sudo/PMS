import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mk-pms-hotel.vercel.app";

/** Public marketing pages may be indexed; the application, the platform console and the APIs may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/pricing", "/contact"], disallow: ["/app/", "/platform", "/api/", "/onboarding", "/security", "/invite", "/reset-password", "/verify-email"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
