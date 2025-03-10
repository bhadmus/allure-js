import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AllureResults, TestResult, TestResultContainer } from "allure-js-commons";
import { LinkType } from "allure-js-commons/sdk/node"

export type TestResultsByFullName = Record<string, TestResult>;

export const runJestInlineTest = async (test: string): Promise<AllureResults> => {
  const res: AllureResults = {
    tests: [],
    groups: [],
    attachments: {},
  };
  const testDir = join(__dirname, "fixtures", randomUUID());
  const configFilePath = join(testDir, "jest.config.js");
  const testFilePath = join(testDir, "sample.test.js");
  const configContent = `
    const config = {
      testEnvironment: require.resolve("allure-jest/node"),
      testEnvironmentOptions: {
        testMode: true,
        links: [
          {
            type: "${LinkType.ISSUE}",
            urlTemplate: "https://example.org/issues/%s",
          },
          {
            type: "${LinkType.TMS}",
            urlTemplate: "https://example.org/tasks/%s",
          }
        ]
      },
    };

    module.exports = config;
  `;

  await mkdir(testDir, { recursive: true });
  await writeFile(configFilePath, configContent, "utf8");
  await writeFile(testFilePath, test, "utf8");

  const modulePath = require.resolve("jest-cli/bin/jest");
  const args = ["--config", configFilePath, testDir];
  const testProcess = fork(modulePath, args, {
    env: {
      ...process.env,
      ALLURE_POST_PROCESSOR_FOR_TEST: String("true"),
    },
    cwd: testDir,
    stdio: "pipe",
  });
  let processError = "";

  testProcess.on("message", (message: string) => {
    const event: { path: string; type: string; data: string } = JSON.parse(message);
    const data = event.type !== "attachment" ? JSON.parse(Buffer.from(event.data, "base64").toString()) : event.data;

    switch (event.type) {
      case "container":
        res.groups.push(data as TestResultContainer);
        break;
      case "result":
        res.tests.push(data as TestResult);
        break;
      case "attachment":
        res.attachments[event.path] = event.data;
        break;
      default:
        break;
    }
  });
  testProcess.stdout?.setEncoding("utf8").on("data", (chunk) => {
    process.stdout.write(String(chunk));
  });
  testProcess.stderr?.setEncoding("utf8").on("data", (chunk) => {
    process.stderr.write(String(chunk));
    processError += chunk;
  });

  return new Promise((resolve) => {
    testProcess.on("exit", async () => {
      await rm(testDir, { recursive: true });

      return resolve(res);
    });
  });
};
