// Print Proofer service worker: offline app shell + Android share-sheet target.
const SHELL = "pp-shell-v1";
const SHARED = "pp-shared";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Images/text shared from another app arrive as a POST to ./share-target
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(handleShare(event.request));
    return;
  }

  // Same-origin GETs: network first, fall back to cache so the app opens offline.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((r) => r || caches.match(new URL("./", self.registration.scope))),
      ),
  );
});

async function handleShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARED);
  for (const key of await cache.keys()) await cache.delete(key);
  const scope = self.registration.scope;
  let i = 0;
  for (const file of form.getAll("images")) {
    if (file && typeof file !== "string") {
      await cache.put(new URL(`shared-file-${i++}`, scope), new Response(file, { headers: { "Content-Type": file.type } }));
    }
  }
  const text = [form.get("title"), form.get("text")].filter((t) => typeof t === "string" && t.trim()).join("\n");
  if (text) await cache.put(new URL("shared-text", scope), new Response(text));
  return Response.redirect(new URL("./?shared=1", scope).href, 303);
}
