module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("assets");
  return {
    dir: { input: "src", output: "dist", includes: "_includes" }
  };
  eleventyConfig.amendLibrary("njk", (njkLibrary) => {
    njkLibrary.configure({ autoescape: false });
  });
};