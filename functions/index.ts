import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "./adapter.mjs";
import { createHandler } from "./handler.mjs";
import { onlyAppCookies, FORWARDED_COOKIE_HEADER } from "./shared/cookies.mjs";
// Injected by the platform at deployment. Never package a local _qoder directory.
import { storage } from "./_qoder/storage.mjs";

const app = createHandler({ storage, env: (name: string) => Deno.env.get(name) });

const siteHandler = serveSite(app, {
  createClient,
  env: (name: string) => Deno.env.get(name),
});

// Measured 2026-10-03: the platform's CDN answers every non-/functions path
// straight from object storage (the HTML responses carry `x-oss-*` headers and
// never reach this module), so this function only ever sees /functions/v1/app.
// That rules out adding response headers to the document from here; the document
// policy has to live in the <meta> tag inside web/index.html.
Deno.serve((request: Request) => {
  // The adapter drops `cookie` before business code runs, so carry only this
  // site's own session cookies across that boundary.
  const forwarded = onlyAppCookies(request.headers.get("cookie"));
  if (!forwarded) return siteHandler(request);
  const headers = new Headers(request.headers);
  headers.set(FORWARDED_COOKIE_HEADER, forwarded);
  return siteHandler(new Request(request, { headers }));
});
