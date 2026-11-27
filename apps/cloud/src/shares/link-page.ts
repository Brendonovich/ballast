import { escapeHtml, html, type HttpResponse } from "../http.ts";

/** Matches `SHARE_LINK_PREFIX` in @ballast/agent-protocol, which parses these links. */
const SHARE_LINK_PREFIX = "/s/";

const codePattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/**
 * The page a share link (`{server}/s/{code}`) opens in a browser. It does
 * not look the share up, so a link reveals nothing a code would not: it
 * shows the link to paste into Ballast's "Use a shared project" step.
 */
export const shareLinkPage = (origin: string, path: string): HttpResponse | undefined => {
  if (!path.startsWith(SHARE_LINK_PREFIX)) return undefined;
  let code: string;
  try {
    code = decodeURIComponent(path.slice(SHARE_LINK_PREFIX.length).replace(/\/$/, ""));
  } catch {
    return undefined;
  }
  if (!codePattern.test(code)) return undefined;
  const link = origin + SHARE_LINK_PREFIX + encodeURIComponent(code);
  return html(
    200,
    `<!doctype html><html><head><meta charset="utf-8"><title>Ballast shared project</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; line-height: 1.5">
<h1>A Ballast project was shared with you</h1>
<p>Open Ballast, choose <strong>Use a shared project</strong> (or <strong>Projects → Subscribe</strong>) and paste this link:</p>
<p style="font-family: ui-monospace, monospace; font-size: 1.1rem; word-break: break-all; padding: 0.75rem; background: #f4f4f5; border-radius: 6px">${escapeHtml(link)}</p>
<p>Share code: <strong style="letter-spacing: 0.1em">${escapeHtml(code.toUpperCase())}</strong></p>
<p style="color: #71717a; font-size: 0.9rem">Shared projects run on your machine without a sandbox. Only subscribe to people you trust.</p>
</body></html>`,
  );
};
