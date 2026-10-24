const { GoogleGenerativeAI } = require('@google/generative-ai');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function requireText(value, label, maxLength = 100000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) throw new HttpError(400, `${label} is too long (maximum ${maxLength} characters).`);
  return value.trim();
}

async function generateJson(content, validate, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new HttpError(503, 'AI service is not configured. Set GEMINI_API_KEY on the backend.');

  const configuredTimeout = Number(process.env.AI_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
    ? Math.min(configuredTimeout, 45000) : 30000;
  const controller = new AbortController();
  let timer;
  try {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
      generationConfig: { temperature: options.temperature ?? 0.1, responseMimeType: 'application/json' }
    });
    const result = await Promise.race([
      model.generateContent(content, { signal: controller.signal }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new HttpError(504, 'AI service timed out. Please try again.'));
        }, timeoutMs);
      })
    ]);
    let data;
    try {
      const responseText = result.response.text().trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      data = JSON.parse(responseText);
    } catch {
      throw new HttpError(502, 'AI service returned invalid JSON. Please try again.');
    }
    if (!isRecord(data) || (validate && !validate(data))) {
      throw new HttpError(502, 'AI service returned an incomplete response. Please try again.');
    }
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted || /abort|timeout/i.test(error.name || '')) {
      throw new HttpError(504, 'AI service timed out. Please try again.');
    }
    throw new HttpError(503, 'AI service is unavailable. Check its API key, quota, and model configuration.');
  } finally {
    clearTimeout(timer);
  }
}

function sendError(res, error, fallback) {
  const status = error instanceof HttpError ? error.status
    : ['CastError', 'ValidationError'].includes(error.name) ? 400 : 500;
  // Provider errors can contain credential-bearing request URLs; never log them.
  console.error(`${fallback} (${error.name || 'Error'})`);
  return res.status(status).json({
    success: false,
    error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid request data.' : fallback
  });
}

module.exports = { generateJson, HttpError, sendError, isRecord, isStringArray, requireText };
