#!/usr/bin/env node
// Injects BreadcrumbList JSON-LD into service and location pages
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '../public');
const BASE = 'https://brakeknights.com';

const SERVICE_PAGES = [
  'brake-pad-rotor-replacement',
  'brake-caliper-repair-replacement',
  'drum-brake-shoe-replacement',
  'brake-hose-replacement',
  'brake-fluid-flush',
  'brake-inspection',
];

// All location pages (brake-repair-*)
const files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
const locationPages = files
  .map(f => f.replace('.html', ''))
  .filter(s => s.startsWith('brake-repair-'));

function cityName(slug) {
  return slug
    .replace('brake-repair-', '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function serviceName(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

let count = 0;

for (const slug of SERVICE_PAGES) {
  const file = path.join(PUBLIC_DIR, `${slug}.html`);
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('BreadcrumbList')) { console.log(`SKIP ${slug}`); continue; }

  const name = serviceName(slug);
  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `${BASE}/` },
      { "@type": "ListItem", "position": 2, "name": "Services", "item": `${BASE}/services` },
      { "@type": "ListItem", "position": 3, "name": name, "item": `${BASE}/${slug}` }
    ]
  }, null, 2);

  html = html.replace('</head>', `  <script type="application/ld+json">\n${schema}\n  </script>\n</head>`);
  fs.writeFileSync(file, html);
  console.log(`✓ service: ${slug}`);
  count++;
}

for (const slug of locationPages) {
  const file = path.join(PUBLIC_DIR, `${slug}.html`);
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('BreadcrumbList')) { console.log(`SKIP ${slug}`); continue; }

  const city = cityName(slug);
  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `${BASE}/` },
      { "@type": "ListItem", "position": 2, "name": "Service Areas", "item": `${BASE}/location` },
      { "@type": "ListItem", "position": 3, "name": city, "item": `${BASE}/${slug}` }
    ]
  }, null, 2);

  html = html.replace('</head>', `  <script type="application/ld+json">\n${schema}\n  </script>\n</head>`);
  fs.writeFileSync(file, html);
  console.log(`✓ location: ${slug}`);
  count++;
}

console.log(`\nDone. Added BreadcrumbList to ${count} pages.`);
