#!/usr/bin/env node
// One-time SEO injection: canonical tags, LocalBusiness JSON-LD, Open Graph, footer NAP
// Run once — skips files that already have canonical tags

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '../public');
const BASE_URL = 'https://brakeknights.com';

const LOCAL_BUSINESS_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "AutoRepair",
  "name": "Brake Knights",
  "description": "Professional mobile brake repair service serving all of Northern Virginia. We come to your home or office — no shop visit required.",
  "url": "https://brakeknights.com",
  "telephone": "+17039774475",
  "email": "greetings@brakeknights.com",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "Sterling",
    "addressRegion": "VA",
    "postalCode": "20164",
    "addressCountry": "US"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 39.0192921,
    "longitude": -77.4232136
  },
  "areaServed": [
    "Sterling VA", "Ashburn VA", "Herndon VA", "Reston VA", "Leesburg VA",
    "McLean VA", "Vienna VA", "Falls Church VA", "Arlington VA", "Alexandria VA",
    "Centreville VA", "Chantilly VA", "Manassas VA", "Fairfax VA", "Springfield VA",
    "Woodbridge VA", "Burke VA", "Gainesville VA", "Haymarket VA", "Purcellville VA",
    "Great Falls VA", "Tysons Corner VA", "Dulles VA", "Lansdowne VA", "Brambleton VA",
    "South Riding VA", "Broadlands VA", "Dale City VA", "Lorton VA", "Aldie VA"
  ],
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      "opens": "09:00",
      "closes": "18:00"
    },
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": "Saturday",
      "opens": "09:00",
      "closes": "15:00"
    }
  ],
  "priceRange": "$$",
  "currenciesAccepted": "USD",
  "paymentAccepted": "Cash, Credit Card, Debit Card, Venmo, Zelle",
  "sameAs": ["https://www.facebook.com/brakeknights"],
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Mobile Brake Repair Services",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Brake Pad & Rotor Replacement" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Brake Caliper Repair & Replacement" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Drum Brake & Shoe Replacement" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Brake Hose Replacement" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Brake Fluid Flush" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Brake Inspection", "offers": { "@type": "Offer", "price": "60", "priceCurrency": "USD" } } }
    ]
  }
};

function getCanonicalUrl(filename) {
  if (filename === 'index.html') return `${BASE_URL}/`;
  return `${BASE_URL}/${filename.replace('.html', '')}`;
}

function extractMeta(html) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
  return {
    title: titleMatch ? titleMatch[1].trim().replace(/&amp;/g, '&') : 'Brake Knights',
    description: descMatch ? descMatch[1].trim() : ''
  };
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHeadInject(filename, title, description, canonicalUrl) {
  const safeTitle = escapeAttr(title);
  const safeDesc = escapeAttr(description);
  const ogImage = `${BASE_URL}/images/logo.png`;

  return `  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Brake Knights">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${ogImage}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${ogImage}">
  <script type="application/ld+json">
${JSON.stringify(LOCAL_BUSINESS_SCHEMA, null, 2)}
  </script>`;
}

const FOOTER_NAP = `    <div style="border-top:1px solid rgba(255,255,255,.12);padding:20px 0 4px;">
      <address style="font-style:normal;font-size:.8125rem;color:#8fa8c0;line-height:1.9;">
        <strong style="color:rgba(255,255,255,.8);">Brake Knights</strong> &nbsp;&middot;&nbsp;
        Sterling, VA 20164 &nbsp;&middot;&nbsp;
        <a href="tel:7039774475" style="color:var(--royal-blue-light);">703-977-4475</a> &nbsp;&middot;&nbsp;
        <a href="mailto:greetings@brakeknights.com" style="color:var(--royal-blue-light);">greetings@brakeknights.com</a>
      </address>
    </div>
`;

const files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
let processed = 0;
let skipped = 0;

for (const filename of files) {
  const filepath = path.join(PUBLIC_DIR, filename);
  let html = fs.readFileSync(filepath, 'utf8');

  if (html.includes('rel="canonical"')) {
    skipped++;
    continue;
  }

  const canonicalUrl = getCanonicalUrl(filename);
  const { title, description } = extractMeta(html);
  const headInject = buildHeadInject(filename, title, description, canonicalUrl);

  html = html.replace('</head>', `${headInject}\n</head>`);

  if (html.includes('<div class="footer-bottom">') && !html.includes('Brake Knights</strong>')) {
    html = html.replace('<div class="footer-bottom">', `${FOOTER_NAP}    <div class="footer-bottom">`);
  }

  fs.writeFileSync(filepath, html, 'utf8');
  processed++;
  console.log(`✓ ${filename.padEnd(50)} ${canonicalUrl}`);
}

console.log(`\nDone. Processed: ${processed}, Skipped (already done): ${skipped}`);
