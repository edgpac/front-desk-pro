import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = "https://frontdesk.tools";
const OUTPUT_PATH = path.join(__dirname, "public", "sitemap.xml");

// Only real marketing/entry pages — not /dashboard/* (app UI, not content)
// or /api/* (not a page at all).
const staticPages = [
  { url: "/", changefreq: "weekly", priority: "1.0" },
  { url: "/demo", changefreq: "monthly", priority: "0.9" },
  { url: "/pricing", changefreq: "monthly", priority: "0.9" },
  { url: "/signup", changefreq: "monthly", priority: "0.7" },
  { url: "/login", changefreq: "yearly", priority: "0.3" },
];

function generateSitemap() {
  const today = new Date().toISOString().split("T")[0];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  staticPages.forEach((page) => {
    xml += "  <url>\n";
    xml += `    <loc>${SITE_URL}${page.url}</loc>\n`;
    xml += `    <lastmod>${today}</lastmod>\n`;
    xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
    xml += `    <priority>${page.priority}</priority>\n`;
    xml += "  </url>\n";
  });

  xml += "</urlset>";
  return xml;
}

function writeSitemap() {
  try {
    const sitemap = generateSitemap();
    const publicDir = path.join(__dirname, "public");
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_PATH, sitemap);
    console.log("✅ Sitemap generated:", OUTPUT_PATH);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

writeSitemap();
