// /api/build-stamp — used by iOS PWA cache busting on cleanweb.
// Returns a stamp that changes every deploy so the client can detect
// "new version available" and prompt a reload.

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const deployId = process.env.VERCEL_DEPLOYMENT_ID || "";
  const stampSource = sha || deployId || Date.now().toString();

  res.status(200).json({
    stamp: stampSource,
    short: stampSource.slice(-6),
    sha: sha || null,
    version: "0.3.0",
    deployedAt: process.env.VERCEL_GIT_COMMIT_AUTHOR_DATE || null
  });
}
