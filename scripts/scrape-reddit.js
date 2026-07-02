import { chromium } from "playwright";
import { readCoupons, writeCoupons, updateCouponStatus } from "./lib/store.js";

// How many to check per run (keep Actions fast)
const MAX_PER_RUN = 40;
const PRUNE_AFTER_DAYS = 7;

async function isCouponFree(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Strategy 1: evaluate the full visible text and look for price indicators
    const result = await page.evaluate(() => {
      // Look for any element that might show a price
      const allText = document.body.innerText || "";

      // Strong free signals
      const freeSignals = [
        /\$\s*0\.00/,
        /price[^a-z]*free/i,
        /free\s*(enroll|access|course)/i,
        /enroll\s*for\s*free/i,
        /add\s*to\s*cart.*\$0/i,
      ];
      for (const re of freeSignals) {
        if (re.test(allText)) return { free: true, reason: re.toString() };
      }

      // Look at price-related elements specifically
      const priceSelectors = [
        '[data-purpose*="price"]',
        '[class*="price"]',
        '[class*="Price"]',
        '[data-purpose*="coupon"]',
        'span[class*="ud-text"]',
        '.base-price-text',
        'div[class*="purchase"] span',
        'button[data-purpose*="buy"] span',
      ];
      const priceTexts = [];
      for (const sel of priceSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.innerText?.trim();
          if (t && t.length < 30) priceTexts.push(t);
        }
      }

      const priceSample = [...new Set(priceTexts)].slice(0, 10);

      // Check each price text
      for (const t of priceSample) {
        if (/free|\$\s*0(\.00)?/i.test(t)) return { free: true, reason: `price element: "${t}"` };
      }

      // Check if coupon applied message exists
      if (/coupon.*applied|discount.*applied/i.test(allText)) {
        // Coupon applied but need to confirm price
        const zeroPriceMatch = allText.match(/\$[\s]*0[\.\d]*/);
        if (zeroPriceMatch) return { free: true, reason: "coupon applied + $0 found" };
      }

      return {
        free: false,
        priceSample,
        snippet: allText.slice(0, 400).replace(/\s+/g, " "),
      };
    });

    if (result.free) {
      console.log(`  ✓ FREE  — ${result.reason}`);
      return true;
    } else {
      console.log(`  ✗ PAID  — price elements: [${(result.priceSample || []).slice(0,5).join(" | ")}]`);
      return false;
    }
  } catch (err) {
    console.warn(`  ⚠ Error checking (will skip): ${err.message.slice(0, 80)}`);
    return null; // null = skip, don't mark expired
  }
}

async function run() {
  const coupons = readCoupons();

  // Pick unverified first, then oldest-checked active ones
  const toCheck = coupons
    .filter(c => c.status !== "expired")
    .sort((a, b) => {
      if (a.status === "unverified" && b.status !== "unverified") return -1;
      if (b.status === "unverified" && a.status !== "unverified") return 1;
      return new Date(a.last_checked || 0) - new Date(b.last_checked || 0);
    })
    .slice(0, MAX_PER_RUN);

  if (!toCheck.length) {
    console.log("Nothing to check.");
  } else {
    console.log(`Checking ${toCheck.length} coupon(s) with Playwright...`);
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    for (const c of toCheck) {
      console.log(`[${c.id}] ${c.course_title.slice(0, 55)}`);
      const page = await browser.newPage();
      try {
        const free = await isCouponFree(page, c.full_url);
        if (free === true) updateCouponStatus(c, "active");
        else if (free === false) updateCouponStatus(c, "expired");
        // null = leave untouched (network error)
      } finally {
        await page.close();
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    await browser.close();
  }

  // Prune old expired entries
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400000;
  const kept = coupons.filter(c =>
    c.status !== "expired" || new Date(c.last_checked || c.found_at).getTime() > cutoff
  );
  writeCoupons(kept);
  console.log(`Done. ${kept.filter(c=>c.status==="active").length} active, ${kept.filter(c=>c.status==="unverified").length} unverified, ${coupons.length-kept.length} pruned.`);
}

run().catch(err => { console.error("Check failed:", err); process.exit(1); });
