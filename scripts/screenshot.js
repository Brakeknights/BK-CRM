#!/usr/bin/env node
// Usage: node scripts/screenshot.js [path] [selector] [output]
//   path     - URL path to visit, e.g. / or /contact (default: /)
//   selector - CSS selector to scroll to, e.g. #contact (default: none)
//   output   - output file path (default: /tmp/screenshot.png)

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const nodePath = require('path');

const urlPath  = process.argv[2] || '/';
const selector = process.argv[3] || '';
const output   = process.argv[4] || '/tmp/screenshot.png';
const PORT     = 3000;

async function main() {
  // Kill any existing process on PORT
  try {
    const pid = execSync(`lsof -t -i:${PORT} 2>/dev/null`).toString().trim();
    if (pid) process.kill(parseInt(pid));
  } catch {}

  // Start server
  const server = spawn('node', [nodePath.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  const cleanup = () => { try { server.kill(); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  await new Promise(r => setTimeout(r, 1500));

  const browser = await chromium.launch();
  const page    = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  // Log in if visiting an admin route
  if (urlPath.startsWith('/admin')) {
    await page.goto(`http://localhost:${PORT}/admin/login`);
    await page.fill('input[name="password"]', process.env.ADMIN_PASSWORD || 'brakeknights');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'load' }).catch(() => {});
  }

  await page.goto(`http://localhost:${PORT}${urlPath}`);

  if (selector) {
    const y = await page.evaluate(
      (sel) => document.querySelector(sel)?.offsetTop ?? 0,
      selector
    );
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(600);
  }

  await page.screenshot({ path: output, fullPage: !selector });
  await browser.close();
  cleanup();

  console.log(output);
}

main().catch(err => { console.error(err); process.exit(1); });
