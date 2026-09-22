import { interactWithCheerio } from "../services/cheerioAiService.js";

export async function interact(req, res) {
  const { question, history, collectedData } = req.body ?? {};

  if (question === undefined || question === null) {
    return res
      .status(400)
      .json({ success: false, message: "Question is required" });
  }
  if (typeof question !== "string") {
    return res
      .status(400)
      .json({ success: false, message: "Question must be a string" });
  }
  if (!question.trim()) {
    return res
      .status(400)
      .json({ success: false, message: "Question is required" });
  }
  if (history !== undefined && !Array.isArray(history)) {
    return res
      .status(400)
      .json({ success: false, message: "History must be an array" });
  }
  if (
    collectedData !== undefined &&
    (typeof collectedData !== "object" ||
      collectedData === null ||
      Array.isArray(collectedData))
  ) {
    return res
      .status(400)
      .json({ success: false, message: "collectedData must be an object" });
  }

  try {
    const data = await interactWithCheerio({
      question,
      history: Array.isArray(history) ? history : [],
      collectedData:
        collectedData && typeof collectedData === "object" ? collectedData : {},
    });

    const answers = Array.isArray(data.answers) ? data.answers : [];

    // tokenUsage is intentionally dropped here — internal AI usage/cost data
    // must never reach the customer-facing frontend.
    return res.status(200).json({
      success: true,
      answer: answers[0] ?? "",
      answers,
      quickReplies: Array.isArray(data.quickReplies) ? data.quickReplies : [],
      context: data.context ?? [],
      collectedData: data.collectedData ?? {},
      products: Array.isArray(data.products) ? data.products : [],
    });
  } catch (error) {
    console.error("AI agent controller error:", error.code || "", error.message);

    if (error.code === "CHEERIO_TIMEOUT") {
      return res.status(504).json({
        success: false,
        message:
          "The assistant is taking too long to respond. Please try again.",
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        success: false,
        message:
          "The assistant is receiving too many requests right now. Please try again shortly.",
      });
    }

    return res.status(502).json({
      success: false,
      message: "Sorry, I couldn't process your request right now. Please try again.",
    });
  }
}

export default interact;
