import fetch from "node-fetch";
import { readCoupons, readExpiredCodes, writeCoupons, writeExpiredCodes, upsertCoupon } from "./lib/store.js";

const UDEMY_REGEX = /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_.]+\/?\?[^"'\s<>]*couponCode=([A-Za-z0-9_\-]+)/gi;

function extractCoupons(text) {
  const decoded = text.replace(/&amp;/g,"&").replace(/&#38;/g,"&");
  return [...decoded.matchAll(UDEMY_REGEX)].map(m => ({
    fullUrl: m[0], couponCode: m[1], courseUrl: m[0].split("?")[0]
  }));
}

function slugToTitle(url) {
  return (url.split("/course/")[1]?.replace(/\/$/, "") ?? "unknown")
    .split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function save(coupons, expiredCodes, found, source, title) {
  let n = 0;
  for (const c of found) {
    if (!c.couponCode) continue;
    if (upsertCoupon(coupons, expiredCodes, {
      course_title: (title || slugToTitle(c.courseUrl)).slice(0, 200),
      course_url: c.courseUrl, coupon_code: c.couponCode,
      full_url: c.fullUrl, source
    })) n++;
  }
  return n;
}

async function fetchText(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
      timeout: 15000,
    });
    return r.ok ? r.text() : "";
  } catch { return ""; }
}

// ─── Source 1: Couponami RSS (formerly Discudemy) ─────────────────────────────
async function scrapeCouponami(coupons, expiredCodes) {
  console.log("=== Couponami RSS ===");
  let total = 0;
  try {
    let xml = await fetchText("https://www.couponami.com/feed");
    if (!xml || xml.length < 100) xml = await fetchText("https://www.discudemy.com/feed");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    console.log(`  ${items.length} items`);
    for (const item of items) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1] ?? "Unknown")
        .replace(/<[^>]+>/g,"").replace(/\[100% OFF\]/gi,"").replace(/&amp;/g,"&").trim();
      let found = extractCoupons(item);
      if (!found.length) {
        const postUrl = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)?.[1]?.trim();
        if (postUrl) {
          const html = await fetchText(postUrl);
          found = extractCoupons(html);
          if (!found.length) {
            const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']*udemy[^"']*couponCode[^"']+)["']/gi)].map(m=>m[1]);
            for (const h of hrefs) found.push(...extractCoupons(h));
          }
          await new Promise(r => setTimeout(r, 600));
        }
      }
      const added = save(coupons, expiredCodes, found, "couponami.com", title);
      if (added) console.log(`  ✓ "${title.slice(0,55)}" +${added}`);
      total += added;
    }
  } catch(e) { console.warn(`Couponami error: ${e.message}`); }
  console.log(`Couponami: ${total} new\n`);
}

// ─── Source 2: UdemyXpert (updates every few minutes) ────────────────────────
async function scrapeUdemyXpert(coupons, expiredCodes) {
  console.log("=== UdemyXpert ===");
  let total = 0;
  try {
    for (let page = 1; page <= 3; page++) {
      const html = await fetchText(`https://udemyxpert.com/courses?page=${page}`);
      if (!html) break;
      let found = extractCoupons(html);
      // Follow individual course page links for any not directly embedded
      const courseLinks = [...new Set(
        [...html.matchAll(/href=["'](https?:\/\/udemyxpert\.com\/[a-zA-Z0-9\-/]+)["']/gi)]
          .map(m=>m[1]).filter(u => !u.endsWith("/courses"))
      )].slice(0, 15);
      for (const link of courseLinks) {
        found.push(...extractCoupons(await fetchText(link)));
        await new Promise(r => setTimeout(r, 400));
      }
      const added = save(coupons, expiredCodes, found, "udemyxpert.com", null);
      console.log(`  Page ${page}: ${found.length} links, ${added} new`);
      total += added;
      await new Promise(r => setTimeout(r, 800));
    }
  } catch(e) { console.warn(`UdemyXpert error: ${e.message}`); }
  console.log(`UdemyXpert: ${total} new\n`);
}

// ─── Source 3: CouponScorpion ─────────────────────────────────────────────────
async function scrapeCouponScorpion(coupons, expiredCodes) {
  console.log("=== CouponScorpion ===");
  let total = 0;
  try {
    // Try their free/100-off listing pages
    const urls = [
      "https://couponscorpion.com/",
      "https://couponscorpion.com/100-off-coupons/",
      "https://couponscorpion.com/development/",
    ];
    for (const url of urls) {
      const html = await fetchText(url);
      const found = extractCoupons(html);
      // Also scan all href attributes for embedded Udemy links
      const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']*udemy[^"']*couponCode[^"']+)["']/gi)].map(m=>m[1]);
      for (const h of hrefs) found.push(...extractCoupons(h));
      const added = save(coupons, expiredCodes, found, "couponscorpion.com", null);
      console.log(`  ${url.split(".com")[1] || "/"}: ${found.length} links, ${added} new`);
      total += added;
      await new Promise(r => setTimeout(r, 800));
    }
  } catch(e) { console.warn(`CouponScorpion error: ${e.message}`); }
  console.log(`CouponScorpion: ${total} new\n`);
}

// ─── Source 4: CourseSpeak ────────────────────────────────────────────────────
async function scrapeCourseSpeak(coupons, expiredCodes) {
  console.log("=== CourseSpeak ===");
  let total = 0;
  try {
    const html = await fetchText("https://coursespeak.com/free-courses/");
    const found = extractCoupons(html);
    const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']*udemy[^"']*couponCode[^"']+)["']/gi)].map(m=>m[1]);
    for (const h of hrefs) found.push(...extractCoupons(h));
    total = save(coupons, expiredCodes, found, "coursespeak.com", null);
    console.log(`  ${found.length} links → ${total} new`);
  } catch(e) { console.warn(`CourseSpeak error: ${e.message}`); }
  console.log(`CourseSpeak: ${total} new\n`);
}

// ─── Source 5: CourseCouponClub ───────────────────────────────────────────────
async function scrapeCourseCouponClub(coupons, expiredCodes) {
  console.log("=== CourseCouponClub ===");
  let total = 0;
  try {
    const html = await fetchText("https://coursecouponclub.com/");
    const found = extractCoupons(html);
    const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']*udemy[^"']*couponCode[^"']+)["']/gi)].map(m=>m[1]);
    for (const h of hrefs) found.push(...extractCoupons(h));
    total = save(coupons, expiredCodes, found, "coursecouponclub.com", null);
    console.log(`  ${found.length} links → ${total} new`);
  } catch(e) { console.warn(`CourseCouponClub error: ${e.message}`); }
  console.log(`CourseCouponClub: ${total} new\n`);
}

async function run() {
  const coupons = readCoupons();
  const expiredCodes = readExpiredCodes();
  const before = coupons.length;

  console.log(`Starting with ${coupons.length} existing coupons, ${expiredCodes.size} blacklisted codes\n`);

  await scrapeCouponami(coupons, expiredCodes);
  await scrapeUdemyXpert(coupons, expiredCodes);
  await scrapeCouponScorpion(coupons, expiredCodes);
  await scrapeCourseSpeak(coupons, expiredCodes);
  await scrapeCourseCouponClub(coupons, expiredCodes);

  writeCoupons(coupons);
  writeExpiredCodes(expiredCodes);

  console.log(`DONE. ${coupons.length - before} new added. ${coupons.length} total in database.`);
}

run().catch(err => { console.error("Scrape failed:", err); process.exit(1); });
