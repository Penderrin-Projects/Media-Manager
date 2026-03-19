// ═══════════════════════════════════════════════════════════════════
// Auth middleware — decoupled from config via getPin callback
// ═══════════════════════════════════════════════════════════════════

/**
 * Create an Express middleware that checks for a PIN in headers or query.
 * Local network requests (no Cloudflare headers) bypass PIN auth.
 *
 * @param {Function} getPin - Returns the current PIN string (empty = no auth)
 * @returns {Function} Express middleware
 */
function createAuthMiddleware(getPin) {
  return function requireAuth(req, res, next) {
    const pin = getPin();
    if (!pin) return next(); // no pin = open access

    // Local network requests bypass PIN (Cloudflare tunnel adds CF-Connecting-IP)
    if (!req.headers['cf-connecting-ip']) return next();

    const provided = req.headers['x-pin'] || req.query.pin;
    if (provided === pin) return next();
    res.status(401).json({ error: 'Invalid PIN' });
  };
}

module.exports = { createAuthMiddleware };
