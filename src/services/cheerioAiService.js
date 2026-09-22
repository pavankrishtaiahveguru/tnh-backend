// ==================================================
// Cheerio AI Agent — outbound integration service
// ==================================================
// Talks to the Cheerio AI Agent API on behalf of the backend. The API key
// never leaves this process — callers only ever see the parsed `data` object.
const CHEERIO_REQUEST_TIMEOUT_MS = 5000;

export async function interactWithCheerio({ question, history, collectedData }) {
  const apiUrl = process.env.CHEERIO_AI_API_URL;
  const apiKey = process.env.CHEERIO_AI_API_KEY;

  if (!apiUrl || !apiKey) {
    const error = new Error("Cheerio AI Agent is not configured");
    error.code = "CHEERIO_NOT_CONFIGURED";
    throw error;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CHEERIO_REQUEST_TIMEOUT_MS,
  );

  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question, history, collectedData }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Cheerio AI Agent request timed out");
      timeoutError.code = "CHEERIO_TIMEOUT";
      throw timeoutError;
    }
    const networkError = new Error("Failed to reach Cheerio AI Agent");
    networkError.code = "CHEERIO_NETWORK_ERROR";
    throw networkError;
  } finally {
    clearTimeout(timeoutId);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      (payload && payload.message) ||
        `Cheerio AI Agent responded with status ${response.status}`,
    );
    error.code = "CHEERIO_HTTP_ERROR";
    error.status = response.status;
    throw error;
  }

  const cheerioStatusOk = !payload || payload.status === undefined || payload.status === 200;
  if (!payload || payload.flag !== true || !cheerioStatusOk || !payload.data) {
    const error = new Error("Cheerio AI Agent returned an unexpected response");
    error.code = "CHEERIO_MALFORMED_RESPONSE";
    throw error;
  }

  return payload.data;
}

export default interactWithCheerio;
