/**
 * Express 5 forwards rejected promises to the error handler, but wrapping keeps
 * handlers explicit and works identically under Express 4 and 5.
 */
const asyncHandler = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
};

module.exports = asyncHandler;
