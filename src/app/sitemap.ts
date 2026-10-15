import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mk-pms-hotel.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return ["", "/pricing", "/contact", "/register", "/login"].map((p) => ({ url: `${base}${p}`, lastModified: now, changeFrequency: p === "/pricing" ? "weekly" : "monthly", priority: p === "" ? 1 : p === "/pricing" ? 0.9 : 0.5 }));
}
