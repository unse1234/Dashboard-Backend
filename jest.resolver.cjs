// Prisma's generated client imports siblings as "./enums.js" while the source is
// TypeScript. Resolve normally first; only on failure retry without the extension.
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if (/^\.{1,2}\/.*\.js$/.test(request)) {
      return options.defaultResolver(request.slice(0, -3), options);
    }
    throw error;
  }
};
