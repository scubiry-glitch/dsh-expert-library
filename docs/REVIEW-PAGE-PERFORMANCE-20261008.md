# Standalone review page load, 2026-10-08

## Evidence

- The standalone review HTML was 339,503 bytes. Three embedded PNGs accounted for 327,484 base64 characters. Each PNG matched an existing packaged `assets/expert-teams/*.png` byte for byte.
- At the initial measurement, `review.js` was 378,346 bytes and `review.css` 102,289 bytes. The review route returned `Cache-Control: no-store` for HTML, JS, and CSS, so the static files were downloaded on each visit. The JS bundle has since changed during concurrent work; its current size is 380,579 bytes.
- The referenced staged plan file was 46,327 bytes. A direct local read took 3.6–4.3 ms after warmup and its wire projection was about 25 KB. Plan-file reading is not the main opening cost for this link.
- The public DSH auth fence returned 401 for `/plugins/dsh-expert-library/assets/*.png`. It also blocked the proposed new `/review/boot/*.png` path even though the route handler served it locally. The deployed shell therefore uses three already-allowlisted `/review/portraits/*.webp` images.
- From the server-side probe location, ten public requests for the current HTML had a median 107 ms response time and a 467 ms maximum; five requests for `review.js` had a median 121 ms and a 746 ms maximum. These are transfer timings, not browser paint or interactive timings, and do not represent the user's network.

## Change prepared

- `index.fast.html` uses the three existing review portraits through `/review/portraits/*.webp`. The served HTML is about 12.3 KB; the images can be cached separately for one day and are marked as low-priority asynchronous decodes.
- The page receives SHA-256 versioned JS/CSS URLs. Matching versions receive `public, max-age=31536000, immutable`; unmatched URLs and the HTML remain `no-store`. All scoped API responses remain `no-store`.
- The original `index.html` remains intact for the currently running DSH process. The new route selects `index.fast.html` after a DSH restart.

## Verification and release state

- `node --test test/review-routes.test.mjs`: 7/7 pass after the concurrent portrait generation completed.
- `npm run typecheck --silent` and `npx tsc -p tsconfig.json`: pass.
- The compiled route returned 200 with 12.3 KB HTML and both versioned asset URLs; static JS/CSS received immutable cache headers.
- **Live shell check:** DSH Web was restarted externally at 00:16:22 SGT. The public route then returned 12,322 HTML bytes, both versioned JS/CSS returned 200 with immutable cache headers, and all three selected portrait URLs returned 200 with one-day cache headers. The current expert task is still `in_progress`; no additional restart was performed for this fix because the HTML file is read per request.
- Authenticated first paint and interactive time remain unmeasured on the user's device.
- This reduces repeat transfer and the HTML critical path. It does not by itself resolve a browser-side `ERR_HTTP2_PING_FAILED`; a client NetLog or Cloudflare Ray from a failed request is still needed for that transport fault.

## Half-second target

- A visible shell within 500 ms on a warm, healthy connection is a performance target, not an achieved result. Measure it as browser first contentful paint on the user's device and network.
- A cold load with data ready for action includes HTML, JS download and execution, and the scoped state request. The current public JS probe already exceeded 500 ms in one sample, so do not claim this end-to-end target without browser evidence and further work.
- Recheck the target only after deployment and after the HTTP/2 ping failures are resolved; record cold and warm browser measurements separately.
