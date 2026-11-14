/**
 * The ZLens brand on the plain pages the server writes itself (the Snowflake app's setup and refusal
 * pages) and the browser icon. Geometry and colours come from the ZLens brand kit ("Signal" cut B):
 * the favicon is the kit's `favicon/favicon.svg` (it follows the browser's light or dark mode), the
 * lockup is `docs/assets/brand/zlens-lockup-horizontal.svg`.
 */

/** The browser icon: the Signal mark, ink on light tab bars and paper on dark ones. */
export const ZLENS_FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
  + '<style>.z{fill:#0F1216}.d{fill:#0E9F74}@media (prefers-color-scheme:dark){.z{fill:#EEF0EA}.d{fill:#2FD8A0}}</style>'
  + '<path class="z" d="M2 2H14V4L5 12H8V14H2V12L11 4H2Z"/><circle class="d" cx="12" cy="12" r="2"/></svg>';

/** The horizontal lockup (mark and wordmark), ink on paper. */
export const ZLENS_LOCKUP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -79.2 384.63 81.58" width="118" height="25" role="img" aria-label="ZLens">'
  + '<g transform="matrix(1.98 0 0 1.98 -21.78 -102.96)"><path d="M11 12H51V20L24 44H39V52H11V44L38 20H11Z" fill="#0F1216"/><circle cx="48" cy="48" r="5.2" fill="#0E9F74"/></g>'
  + '<path d="M113.8 0V-9L154.43 -66.9L157.9 -61.73H115.06V-72H167.43V-63L127.2 -5.57L123.86 -10.27H168.03V0Z M176.43 0V-72H189.43V0ZM182.63 0V-10.27H224.83V0Z M252.66 1Q244.56 1 238.5 -2.38Q232.43 -5.77 229.06 -11.77Q225.7 -17.77 225.7 -25.57Q225.7 -33.43 229.05 -39.38Q232.4 -45.33 238.43 -48.67Q244.46 -52 252.4 -52Q260.03 -52 265.65 -48.83Q271.26 -45.67 274.35 -40Q277.43 -34.33 277.43 -26.67Q277.43 -25.27 277.35 -24.07Q277.26 -22.87 277.06 -21.7H233.56V-30.53H267.36L264.76 -28.1Q264.76 -35.3 261.45 -38.92Q258.13 -42.53 252.26 -42.53Q245.8 -42.53 242.08 -38.12Q238.36 -33.7 238.36 -25.4Q238.36 -17.17 242.08 -12.82Q245.8 -8.47 252.73 -8.47Q256.76 -8.47 259.73 -9.98Q262.7 -11.5 264.13 -14.63H276.06Q273.56 -7.37 267.58 -3.18Q261.6 1 252.66 1Z M284.8 0V-51H297.1V-39H297.46V0ZM320.63 0V-32.2Q320.63 -36.93 318.23 -39.3Q315.83 -41.67 311.2 -41.67Q307.2 -41.67 304.08 -39.87Q300.96 -38.07 299.21 -34.9Q297.46 -31.73 297.46 -27.47L296.16 -39.7Q298.7 -45.33 303.71 -48.67Q308.73 -52 315.73 -52Q324.06 -52 328.68 -47.32Q333.3 -42.63 333.3 -34.83V0Z M363.3 1Q352.7 1 346.43 -3.45Q340.16 -7.9 339.5 -15.83H351Q351.56 -11.93 354.73 -9.9Q357.9 -7.87 363.36 -7.87Q368.26 -7.87 370.7 -9.43Q373.13 -11 373.13 -13.9Q373.13 -16.03 371.73 -17.38Q370.33 -18.73 366.43 -19.63L358.23 -21.47Q349.83 -23.33 345.8 -27.15Q341.76 -30.97 341.76 -36.77Q341.76 -43.9 347.2 -47.95Q352.63 -52 362.23 -52Q371.73 -52 377.46 -47.97Q383.2 -43.93 383.83 -36.77H372.33Q371.83 -39.87 369.2 -41.5Q366.56 -43.13 361.93 -43.13Q357.63 -43.13 355.43 -41.75Q353.23 -40.37 353.23 -37.83Q353.23 -35.77 354.95 -34.43Q356.66 -33.1 360.66 -32.13L369.46 -30.13Q376.96 -28.43 380.8 -24.23Q384.63 -20.03 384.63 -14.27Q384.63 -7.03 379.03 -3.02Q373.43 1 363.3 1Z" fill="#0F1216"/>'
  + '</svg>';

const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ZLENS_FAVICON_SVG)}">`;

/**
 * A plain page in the ZLens brand: the lockup above the content, the brand's ink, paper and green, and
 * the mark as the browser icon (inline, so it needs no other request). `title` is plain text; `body`
 * is HTML the caller has escaped.
 */
export function brandedPage(input: { title: string; body: string }): string {
  const title = input.title.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const style = [
    'body{margin:0;background:#F7F7F4;color:#0F1216;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55}',
    'main{max-width:44rem;margin:10vh auto;padding:0 1.25rem}',
    '.brand{display:block;margin-bottom:2rem}',
    'h1{font-size:1.6rem;font-weight:650;letter-spacing:-0.01em;margin:0 0 .75rem}',
    'li{margin:.5rem 0}',
    'pre{background:#fff;border:1px solid #E2E3DD;border-radius:8px;padding:.75rem;overflow-x:auto;font-size:.85rem}',
    'code{background:#fff;border:1px solid #E2E3DD;border-radius:4px;padding:0 .25rem}',
    'strong{font-weight:650}',
    '.note{color:#4A5058;font-size:.92rem}',
    '.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:#0E9F74;margin-right:.45rem;vertical-align:.05rem}',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${FAVICON_LINK}<style>${style}</style></head>`
    + `<body><main><span class="brand">${ZLENS_LOCKUP_SVG}</span>${input.body}</main></body></html>`;
}
