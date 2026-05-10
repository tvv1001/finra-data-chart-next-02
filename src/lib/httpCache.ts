export function sharedCacheHeaders(
  sMaxAgeSeconds = 300,
  staleWhileRevalidateSeconds = 86400,
) {
  return {
    "Cache-Control": `public, s-maxage=${sMaxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`,
  };
}
