// Copies ../shared into src/shared before compiling (tests and fixtures stay out of the deploy bundle).
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "../../shared");
const dst = path.resolve(__dirname, "../src/shared");
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, {
  recursive: true,
  filter: (p) => !path.relative(src, p).split(path.sep).some((part) => part === "test" || part === "fixtures"),
});
