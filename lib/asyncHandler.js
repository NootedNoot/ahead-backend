// Express 4 does NOT catch a rejected promise thrown from an async route
// handler - it just becomes an unhandled rejection that crashes the whole
// process, taking down every other in-flight request with it. Every async
// route in this codebase is wrapped in this so a DB hiccup or any other
// unexpected error becomes a normal 500 response instead of an outage.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = asyncHandler;
