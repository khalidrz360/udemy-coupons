import fetch from "node-fetch";
import { chromium } from "playwright";
import { readCoupons, writeCoupons, upsertCoupon } from "./lib/store.js";

const UDEMY_REGEX = /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_.]+\/?\?[^"'\s<>]*couponCode=([A-Za-z0-9_\-]+)/gi;

function extractCoupons(text) {
  const decoded = text.replace(/&amp;/g,"&").replace(/&#38;/g,"&").replace(/\\u0026/g,"&");
  return [...decoded.matchAll(UDEMY_REGEX)].map(m => ({ fullUrl: m[0], couponCode: m[1], courseUrl: m[0].split("?")[0] }));
}

async function fetchWithInfo(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "text/html,*/*" },
    redirect: "follow",
  });
  const text = r.ok ? await r.text() : "";
  return { text, finalUrl: r.url, status: r.status };
}

function slugToTitle(url) {
  return (url.split("/course/")[1]?.replace(/\/$/, "") ?? "unknown").split("-").map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
}

function save(coupons, found, source, title) {
  let n = 0;
  for (const c of found) {
    if (!c.couponCode) continue;
    if (upsertCoupon(coupons, { course_title: (title||slugToTitle(c.courseUrl)).slice(0,200), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source })) n++;
  }
  return n;
}

// ─── Source 1: Discudemy RSS with multi-level following + diagnostics ─────────
async function scrapeDiscudemyRSS(coupons) {
  console.log("=== Discudemy RSS ===");
  let total = 0;
  try {
    const { text: xml } = await fetchWithInfo("https://www.discudemy.com/feed");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>m[1]);
    console.log(`  ${items.length} items in feed`);

    for (const item of items.slice(0, 10)) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1] ?? "Unknown").replace(/<[^>]+>/g,"").trim();
      const postUrl = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)?.[1]?.trim();
      if (!postUrl) continue;

      let found = extractCoupons(item);
      if (found.length) { total += save(coupons, found, "discudemy.com", title); continue; }

      try {
        const { text: postHtml, finalUrl: postFinal } = await fetchWithInfo(postUrl);
        // If post page itself redirected to Udemy
        if (postFinal.includes("udemy.com") && postFinal.includes("couponCode")) {
          found = extractCoupons(postFinal);
        }
        if (!found.length) found = extractCoupons(postHtml);

        if (!found.length) {
          // Find all hrefs in post page for diagnostics
          const hrefs = [...postHtml.matchAll(/href=["']([^"']+)["']/gi)].map(m=>m[1]).filter(h=>h.includes("discudemy")||h.includes("udemy")).slice(0,5);
          console.log(`  "${title.slice(0,40)}" hrefs: ${hrefs.join(" | ") || "none"}`);
          const udemyCount = (postHtml.match(/udemy/gi)||[]).length;
          console.log(`    udemy mentions: ${udemyCount}, couponCode mentions: ${(postHtml.match(/couponCode/gi)||[]).length}`);

          // Follow /go/ links
          const goUrl = hrefs.find(h=>h.includes("/go/")) || [...postHtml.matchAll(/href=["'](\/go\/[^"']+)["']/gi)].map(m=>`https://www.discudemy.com${m[1]}`)[0];
          if (goUrl) {
            const { text: goHtml, finalUrl: goFinal, status } = await fetchWithInfo(goUrl);
            console.log(`    /go/ → final: ${goFinal.slice(0,100)} (${status})`);
            // Server-side redirect already to Udemy?
            if (goFinal.includes("udemy.com") && goFinal.includes("couponCode")) {
              found = extractCoupons(goFinal);
            }
            if (!found.length) found = extractCoupons(goHtml);
            // meta refresh
            if (!found.length) {
              const meta = goHtml.match(/content=["'][^"']*(?:url|URL)=(https?:\/\/[^"']+)["']/i);
              if (meta) { console.log(`    meta: ${meta[1].slice(0,80)}`); found = extractCoupons(meta[1]); }
            }
            // JS redirect patterns
            if (!found.length) {
              const js = goHtml.match(/["'](https?:\/\/(?:www\.)?udemy\.com\/course\/[^"']+couponCode[^"']+)["']/i);
              if (js) { console.log(`    js url: ${js[1].slice(0,80)}`); found = extractCoupons(js[1]); }
            }
            if (!found.length) {
              // Print raw text of /go/ page for debugging
              const raw = goHtml.replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,500);
              console.log(`    /go/ raw text: ${raw}`);
            }
          }
        }
      } catch(e) { console.warn(`  Error: ${e.message}`); }

      total += save(coupons, found, "discudemy.com", title);
      await new Promise(r=>setTimeout(r,1200));
    }
  } catch(e) { console.warn(`Discudemy RSS failed: ${e.message}`); }
  console.log(`Discudemy RSS: ${total} new`);
}

// ─── Source 2: Tutorialbar RSS ─────────────────────────────────────────────────
async function scrapeTutorialbar(coupons) {
  console.log("=== Tutorialbar RSS ===");
  let total = 0;
  try {
    const { text: xml } = await fetchWithInfo("https://www.tutorialbar.com/all-courses/feed/");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>m[1]);
    console.log(`  ${items.length} items`);
    for (const item of items) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1] ?? "Unknown").replace(/<[^>]+>/g,"").trim();
      let found = extractCoupons(item);
      if (!found.length) {
        const postUrl = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)?.[1]?.trim();
        if (postUrl) {
          try {
            const { text: html, finalUrl } = await fetchWithInfo(postUrl);
            if (finalUrl.includes("couponCode")) found = extractCoupons(finalUrl);
            if (!found.length) found = extractCoupons(html);
          } catch {}
        }
      }
      total += save(coupons, found, "tutorialbar.com", title);
    }
  } catch(e) { console.warn(`Tutorialbar error: ${e.message}`); }
  console.log(`Tutorialbar: ${total} new`);
}

// ─── Source 3: GitHub API code search ─────────────────────────────────────────
async function scrapeGitHub(coupons) {
  console.log("=== GitHub API ===");
  let total = 0;
  try {
    const r = await fetch("https://api.github.com/search/code?q=couponCode+udemy.com+course&sort=indexed&order=desc&per_page=20", {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "udemy-coupon-collector" }
    });
    const data = await r.json();
    console.log(`  ${data.total_count ?? 0} total results, ${(data.items||[]).length} returned`);
    for (const item of (data.items||[]).slice(0, 15)) {
      try {
        const rawUrl = item.html_url.replace("github.com","raw.githubusercontent.com").replace("/blob/","/");
        const { text } = await fetchWithInfo(rawUrl);
        const found = extractCoupons(text);
        if (found.length) console.log(`  ${item.name}: ${found.length} coupons found`);
        total += save(coupons, found, "github.com", null);
      } catch(e) { console.warn(`  ${e.message}`); }
      await new Promise(r=>setTimeout(r,700));
    }
  } catch(e) { console.warn(`GitHub error: ${e.message}`); }
  console.log(`GitHub: ${total} new`);
}

// ─── Source 4: Playwright — follow JS redirect on Discudemy /go/ pages ────────
async function scrapePlaywrightRedirect(coupons) {
  console.log("=== Playwright redirect follower ===");
  let total = 0;
  try {
    const { text: xml } = await fetchWithInfo("https://www.discudemy.com/feed");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>m[1]);
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"] });
    for (const item of items.slice(0, 6)) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1] ?? "Unknown").replace(/<[^>]+>/g,"").trim();
      const postUrl = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)?.[1]?.trim();
      if (!postUrl) continue;
      const page = await browser.newPage();
      try {
        await page.goto(postUrl, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(2000);
        const goHref = await page.$eval('a[href*="/go/"]', el=>el.href).catch(()=>null);
        console.log(`  "${title.slice(0,35)}" → go link: ${goHref?.slice(0,80) ?? "NOT FOUND"}`);
        if (goHref) {
          const goPage = await browser.newPage();
          try {
            await goPage.goto(goHref, { waitUntil: "domcontentloaded", timeout: 15000 });
            await goPage.waitForTimeout(9000); // wait for JS redirect
            const finalUrl = goPage.url();
            console.log(`    after 9s: ${finalUrl.slice(0,100)}`);
            if (finalUrl.includes("udemy.com") && finalUrl.includes("couponCode")) {
              const clean = finalUrl.replace(/&amp;/g,"&");
              const code = new URL(clean).searchParams.get("couponCode");
              if (code && upsertCoupon(coupons,{course_title:title,course_url:clean.split("?")[0],coupon_code:code,full_url:clean,source:"discudemy.com"})) {
                total++; console.log(`    ✓ coupon: ${code}`);
              }
            } else {
              const found = extractCoupons(await goPage.content());
              total += save(coupons, found, "discudemy.com", title);
            }
          } finally { await goPage.close(); }
        }
      } catch(e) { console.warn(`  Playwright error: ${e.message}`); }
      finally { await page.close(); }
      await new Promise(r=>setTimeout(r,2000));
    }
    await browser.close();
  } catch(e) { console.warn(`Playwright error: ${e.message}`); }
  console.log(`Playwright: ${total} new`);
}

async function run() {
  const coupons = readCoupons();
  const before = coupons.length;
  await scrapeDiscudemyRSS(coupons);
  await scrapeTutorialbar(coupons);
  await scrapeGitHub(coupons);
  await scrapePlaywrightRedirect(coupons);
  writeCoupons(coupons);
  console.log(`\n=== DONE: ${coupons.length-before} new, ${coupons.length} total ===`);
}

run().catch(err=>{ console.error("Scrape failed:", err); process.exit(1); });
