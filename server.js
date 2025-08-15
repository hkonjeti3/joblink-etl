import express from "express";
import { chromium } from "playwright-chromium";

const app = express();
const PORT = process.env.PORT || 8080;
const RENDERER_KEY = process.env.RENDERER_KEY || ""; // optional shared secret

// basic health check
app.get("/", (req, res) => res.send("ok"));

app.get("/render", async (req, res) => {
  try {
    if (RENDERER_KEY) {
      const key = req.header("x-renderer-key") || "";
      if (key !== RENDERER_KEY) return res.status(401).json({ error: "bad key" });
    }
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "missing url" });

    const wait = (req.query.wait || "domcontentloaded");
    const timeout = Math.min(parseInt(req.query.timeout || "12000", 10), 20000);

    const t0 = Date.now();
    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: true
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    });
    const page = await context.newPage();

    // block noisy assets (keeps it light)
    await page.route("**/*", route => {
      const r = route.request();
      const type = r.resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });

    const resp = await page.goto(url, { waitUntil: wait, timeout });
    const status = resp ? resp.status() : 0;
    const html = await page.content();
    const finalUrl = page.url();

    await browser.close();

    res.json({
      status,
      finalUrl,
      html,
      ms: Date.now() - t0,
      wait
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`Renderer on :${PORT}`));
