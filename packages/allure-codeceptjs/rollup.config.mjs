import typescriptPlugin from "@rollup/plugin-typescript";
import { globSync } from "glob";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "rollup";

const dirname = fileURLToPath(new URL(".", import.meta.url));

const createNodeEntry = (inputFile) => {
  const outputFileBase = inputFile.replace(/^src/, "dist");
  const external = [
    "allure-js-commons",
    "allure-js-commons/sdk/node",
    "strip-ansi",
    "codeceptjs",
    "node:path",
  ];

  return [
    defineConfig({
      input: inputFile,
      output: {
        file: join(dirname, outputFileBase.replace(/\.ts$/, ".mjs")),
        format: "esm",
        sourcemap: true,
      },
      plugins: [
        typescriptPlugin({
          tsconfig: "./tsconfig.rollup.json",
        }),
      ],
      external,
    }),
    defineConfig({
      input: inputFile,
      output: {
        file: join(dirname, outputFileBase.replace(/\.ts$/, ".cjs")),
        format: "cjs",
        sourcemap: true,
      },
      plugins: [
        typescriptPlugin({
          tsconfig: "./tsconfig.rollup.json",
        }),
      ],
      external,
    }),
  ];
};

export default () => {
  const entries = globSync("src/*.ts", { cwd: dirname });

  return entries.map(createNodeEntry).flat();
};
