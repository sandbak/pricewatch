/**
 * Retry wrapper with exponential backoff.
 *
 * Only retries on:
 *   - Network / timeout errors (no response received)
 *   - 5xx server status codes
 *
 * Does NOT retry on:
 *   - 4xx client errors
 *   - Any error whose message indicates a CAPTCHA page
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_BACKOFF_FACTOR = 2;

function isRetryableError(err) {
  // Never retry CAPTCHA detections (e.g. from the Amazon scraper)
  if (/captcha/i.test(err.message)) {
    return false;
  }

  // Axios errors with a response object — only retry 5xx
  if (err.response) {
    return err.response.status >= 500;
  }

  // No response means network / timeout / DNS error — retryable
  return true;
}

/**
 * Wraps an async function so it is retried on transient failures.
 *
 * @param {Function} fn          The async function to execute.
 * @param {Object}   opts
 * @param {number}   opts.maxAttempts   Total attempts (default 3).
 * @param {number}   opts.baseDelayMs   Delay before first retry (default 2000ms).
 * @param {number}   opts.backoffFactor Multiplier applied to delay each retry (default 2).
 * @returns {Function} A new async function with the same signature as `fn`.
 */
function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const backoffFactor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;

  return async function retried(...args) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        lastError = err;

        if (!isRetryableError(err) || attempt === maxAttempts) {
          throw err;
        }

        const delayMs = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
        console.warn(
          `[retry] Attempt ${attempt}/${maxAttempts} failed (${err.message}). ` +
            `Retrying in ${delayMs}ms…`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Should be unreachable, but just in case:
    throw lastError;
  };
}

module.exports = { withRetry };
