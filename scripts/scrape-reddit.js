// Pulls recent posts from public, read-only Reddit JSON endpoints (no login/API key
// needed), looks for Udemy course links that contain a couponCode param, and stores
// any new ones in docs/data/coupons.json as "unverified" (their real validity is
// confirmed separately by scripts/check-coupons.js).
//
// NOTE: Reddit may rate-limit or block requests without a proper User-Agent, or from
// certain IP ranges over time. If this stops working reliably, register a free app at
// https://www.reddit.com/prefs/apps and switch this to Reddit's official OAuth API.

import fetch from "node-fetch";
import { readCoupons, writeCoupons, upsertCoupon } from "./lib/store.js";

const SUBREDDITS = [
  "udemyfreebies",
  "FreeUdemyCourse",
  "udemyFreeCoupon",
  "udemycoupon",
];

const UDEMY_URL_REGEX =
  /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_/]+\/?\?[^\s)"\]]*couponCode=([A-Za-z0-9_\-]+)/g;

async function fetchSubredditPosts(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=50`;
  const res = await fetch(url, {
    headers: { "User-Agent": "udemy-coupon-collector/1.0 (personal project)" },
  });
  if (!res.ok) {
    console.warn(`[${subreddit}] request failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const json = await res.json();
  return json?.data?.children ?? [];
}

function extractCoupons(text) {
  const matches = [...text.matchAll(UDEMY_URL_REGEX)];
  return matches.map((m) => ({
    fullUrl: m[0],
    couponCode: m[1],
    courseUrl: m[0].split("?")[0],
  }));
}

async function run() {
  const coupons = readCoupons();
  let totalFound = 0;
  let totalNew = 0;

  for (const subreddit of SUBREDDITS) {
    console.log(`Scanning r/${subreddit}...`);
    let posts;
    try {
      posts = await fetchSubredditPosts(subreddit);
    } catch (err) {
      console.warn(`[${subreddit}] error: ${err.message}`);
      continue;
    }

    for (const post of posts) {
      const data = post.data;
      const haystack = `${data.title ?? ""} ${data.url ?? ""} ${data.selftext ?? ""}`;
      const found = extractCoupons(haystack);

      for (const coupon of found) {
        totalFound++;
        const added = upsertCoupon(coupons, {
          course_title: data.title?.slice(0, 200) ?? "Unknown course",
          course_url: coupon.courseUrl,
          coupon_code: coupon.couponCode,
          full_url: coupon.fullUrl,
          source: `reddit:r/${subreddit}`,
        });
        if (added) totalNew++;
      }
    }

    await new Promise((r) => setTimeout(r, 1500)); // be polite between requests
  }

  writeCoupons(coupons);
  console.log(`Done. Found ${totalFound} coupon links, ${totalNew} new.`);
}

run().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});
