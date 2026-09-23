// ==================================================
// Isolated Cheerio AI Agent connectivity/timing test
// Run: node scripts/testCheerio.mjs
// Never logs the API key.
// ==================================================
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url) });

const apiUrl = process.env.CHEERIO_AI_API_URL;
const apiKey = process.env.CHEERIO_AI_API_KEY;

console.log("[Cheerio Test] Starting...");
console.log("[Cheerio Test] API key configured:", Boolean(apiKey));
console.log("[Cheerio Test] URL:", apiUrl);

const startedAt = Date.now();
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30000);

try {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question: "hi", history: [], collectedData: {} }),
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  console.log(`[Cheerio Test] Response: ${response.status}`);
  const data = await response.json();
  console.log("[Cheerio Test] flag:", data.flag, "status field:", data.status);
  console.log(`[Cheerio Test] Total time: ${Date.now() - startedAt}ms`);
} catch (error) {
  clearTimeout(timeoutId);
  console.log(`[Cheerio Test] FAILED after ${Date.now() - startedAt}ms:`, error.name, error.message);
}
