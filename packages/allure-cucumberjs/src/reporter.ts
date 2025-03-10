import { Formatter, IFormatterOptions, TestCaseHookDefinition } from "@cucumber/cucumber";
import * as messages from "@cucumber/messages";
import { PickleTag, Tag, TestStepResult, TestStepResultStatus } from "@cucumber/messages";
import os from "node:os";
import process from "node:process";
import { ALLURE_RUNTIME_MESSAGE_CONTENT_TYPE } from "allure-js-commons/internal";
import {
  AllureNodeReporterRuntime,
  Config,
  ContentType,
  FileSystemAllureWriter,
  Label,
  LabelName,
  Link,
  MessageAllureWriter,
  Stage,
  Status,
  TestResult,
  createStepResult,
  getWorstStepResultStatus,
} from "allure-js-commons/sdk/node";
import { AllureCucumberReporterConfig, LabelConfig, LinkConfig } from "./model";

const { ALLURE_THREAD_NAME } = process.env;

export default class AllureCucumberReporter extends Formatter {
  private readonly afterHooks: TestCaseHookDefinition[];
  private readonly beforeHooks: TestCaseHookDefinition[];

  private linksConfigs: LinkConfig[] = [];
  private labelsConfigs: LabelConfig[] = [];
  private runtime: AllureNodeReporterRuntime;

  private readonly documentMap: Map<string, messages.GherkinDocument> = new Map();
  private readonly scenarioMap: Map<string, messages.Scenario> = new Map();
  private readonly stepMap: Map<string, messages.Step> = new Map();
  private readonly testStepMap: Map<string, messages.TestStep> = new Map();
  private readonly pickleStepMap: Map<string, messages.PickleStep> = new Map();
  private readonly testCaseTestStepsResults: Map<string, messages.TestStepResult[]> = new Map();
  private readonly pickleMap: Map<string, messages.Pickle> = new Map();
  private readonly hookMap: Map<string, messages.Hook> = new Map();
  private readonly testCaseMap: Map<string, messages.TestCase> = new Map();
  private readonly testCaseStartedMap: Map<string, messages.TestCaseStarted> = new Map();

  private readonly allureResultsUuids: Map<string, string> = new Map();

  constructor(options: IFormatterOptions) {
    super(options);

    const {
      resultsDir = "./allure-results",
      testMode,
      links,
      labels,
      ...rest
    } = options.parsedArgvOptions as AllureCucumberReporterConfig;

    this.runtime = new AllureNodeReporterRuntime({
      writer: testMode
        ? new MessageAllureWriter()
        : new FileSystemAllureWriter({
            resultsDir,
          }),
      links: links as Config["links"] | undefined,
      ...rest,
    });
    this.linksConfigs = links || [];
    this.labelsConfigs = labels || [];

    options.eventBroadcaster.on("envelope", this.parseEnvelope.bind(this));

    this.beforeHooks = options.supportCodeLibrary.beforeTestCaseHookDefinitions;
    this.afterHooks = options.supportCodeLibrary.afterTestCaseHookDefinitions;
  }

  private get tagsIgnorePatterns(): RegExp[] {
    const { labelsConfigs, linksConfigs } = this;

    return [...labelsConfigs, ...linksConfigs].flatMap(({ pattern }) => pattern);
  }

  private parseEnvelope(envelope: messages.Envelope) {
    switch (true) {
      case !!envelope.gherkinDocument:
        this.onGherkinDocument(envelope.gherkinDocument);
        break;
      case !!envelope.pickle:
        this.onPickle(envelope.pickle);
        break;
      case !!envelope.testCase:
        this.onTestCase(envelope.testCase);
        break;
      case !!envelope.testCaseStarted:
        this.onTestCaseStarted(envelope.testCaseStarted);
        break;
      case !!envelope.testCaseFinished:
        this.onTestCaseFinished(envelope.testCaseFinished);
        break;
      case !!envelope.attachment:
        this.onAttachment(envelope.attachment);
        break;
      case !!envelope.hook:
        this.onHook(envelope.hook);
        break;
      case !!envelope.testStepStarted:
        this.onTestStepStarted(envelope.testStepStarted);
        break;
      case !!envelope.testStepFinished:
        this.onTestStepFinished(envelope.testStepFinished);
        break;
    }
  }

  private parseTagsLabels(tags: readonly Tag[]): Label[] {
    const labels: Label[] = [];

    if (this.labelsConfigs.length === 0) {
      return labels;
    }

    this.labelsConfigs.forEach((matcher) => {
      const matchedTags = tags.filter((tag) => matcher.pattern.some((pattern) => pattern.test(tag.name)));
      const matchedLabels = matchedTags.map((tag) => {
        const tagValue = tag.name.replace(/^@\S+:/, "");

        return {
          name: matcher.name,
          value: tagValue,
        };
      });

      labels.push(...matchedLabels);
    });

    return labels;
  }

  private parsePickleTags(tags: readonly PickleTag[]): Label[] {
    return tags
      .filter((tag) => !this.tagsIgnorePatterns.some((pattern) => pattern.test(tag.name)))
      .map((tag) => ({
        name: LabelName.TAG,
        value: tag.name,
      }));
  }

  private parseTagsLinks(tags: readonly Tag[]): Link[] {
    const tagKeyRe = /^@\S+=/;
    const links: Link[] = [];

    if (this.linksConfigs.length === 0) {
      return links;
    }

    this.linksConfigs.forEach((matcher) => {
      const matchedTags = tags.filter((tag) => matcher.pattern.some((pattern) => pattern.test(tag.name)));
      const matchedLinks = matchedTags.map((tag) => {
        const tagValue = tag.name.replace(tagKeyRe, "");

        return {
          url: matcher.urlTemplate.replace(/%s$/, tagValue) || tagValue,
          type: matcher.type,
        };
      });

      links.push(...matchedLinks);
    });

    return links;
  }

  private parseStatus(stepResult: TestStepResult): Status | undefined {
    const containsAssertionError = /assertion/i.test(stepResult?.exception?.type || "");

    switch (stepResult.status) {
      case TestStepResultStatus.FAILED:
        return containsAssertionError ? Status.FAILED : Status.BROKEN;
      case TestStepResultStatus.PASSED:
        return Status.PASSED;
      case TestStepResultStatus.SKIPPED:
      case TestStepResultStatus.PENDING:
        return Status.SKIPPED;
      default:
        return undefined;
    }
  }

  private onRule(data: messages.Rule): void {
    data.children?.forEach((c) => {
      if (c.scenario) {
        this.onScenario(c.scenario);
      }
    });
  }

  private onGherkinDocument(data: messages.GherkinDocument): void {
    if (data.uri) {
      this.documentMap.set(data.uri, data);
    }

    data.feature?.children?.forEach((c) => {
      if (c.rule) {
        this.onRule(c.rule);
      } else if (c.scenario) {
        this.onScenario(c.scenario);
      }
    });
  }

  private onScenario(data: messages.Scenario): void {
    this.scenarioMap.set(data.id, data);
    data.steps.forEach((step) => this.stepMap.set(step.id, step));
  }

  private onPickle(data: messages.Pickle): void {
    this.pickleMap.set(data.id, data);
    data.steps.forEach((ps) => this.pickleStepMap.set(ps.id, ps));
  }

  private onTestCase(data: messages.TestCase): void {
    this.testCaseMap.set(data.id, data);
    data.testSteps.forEach((ts) => this.testStepMap.set(ts.id, ts));
  }

  private onTestCaseStarted(data: messages.TestCaseStarted) {
    const testCase = this.testCaseMap.get(data.testCaseId)!;
    const pickle = this.pickleMap.get(testCase.pickleId)!;
    const doc = this.documentMap.get(pickle.uri)!;
    const [scenarioId] = pickle.astNodeIds;
    const scenario = this.scenarioMap.get(scenarioId);
    const fullName = `${pickle.uri}#${pickle.name}`;
    const result: Partial<TestResult> = {
      name: pickle.name,
      description: (scenario?.description || doc?.feature?.description || "").trim(),
      labels: [],
      links: [],
      testCaseId: this.runtime.crypto.md5(fullName),
      start: Date.now(),
      fullName,
    };

    result.labels!.push(
      {
        name: LabelName.HOST,
        value: os.hostname(),
      },
      {
        name: LabelName.LANGUAGE,
        value: "javascript",
      },
      {
        name: LabelName.FRAMEWORK,
        value: "cucumberjs",
      },
      {
        name: LabelName.THREAD,
        value: data.workerId || ALLURE_THREAD_NAME || process.pid.toString(),
      },
    );

    if (doc?.feature) {
      result.labels!.push({
        name: LabelName.FEATURE,
        value: doc.feature.name,
      });
    }

    if (scenario) {
      result.labels!.push({
        name: LabelName.SUITE,
        value: scenario.name,
      });
    }

    const pickleLabels = this.parsePickleTags(pickle.tags || []);
    const featureLabels = this.parseTagsLabels(doc?.feature?.tags || []);
    const featureLinks = this.parseTagsLinks(doc?.feature?.tags || []);
    const scenarioLabels = this.parseTagsLabels(scenario?.tags || []);
    const scenarioLinks = this.parseTagsLinks(scenario?.tags || []);

    result.labels!.push(...featureLabels, ...scenarioLabels, ...pickleLabels);
    result.links!.push(...featureLinks, ...scenarioLinks);

    const testUuid = this.runtime.startTest(result);

    this.testCaseStartedMap.set(data.id, data);
    this.allureResultsUuids.set(data.id, testUuid as string);

    if (!scenario?.examples) {
      return;
    }

    scenario.examples.forEach((example) => {
      const csvDataTableHeader = example?.tableHeader?.cells.map((cell) => cell.value).join(",") || "";
      const csvDataTableBody =
        example?.tableBody.map((row) => row.cells.map((cell) => cell.value).join(",")).join("\n") || "";

      if (!csvDataTableHeader && !csvDataTableBody) {
        return;
      }

      const csvDataTable = `${csvDataTableHeader}\n${csvDataTableBody}\n`;

      // TODO: actually we don't need to write the same attachment multiple times, just need to keep them in Map and then re-use for each test
      this.runtime.writeAttachment(
        {
          name: "Examples",
          content: csvDataTable,
          contentType: ContentType.CSV,
          encoding: "utf8",
        },
        testUuid,
      );
    });
  }

  private onTestCaseFinished(data: messages.TestCaseFinished) {
    const testUuid = this.allureResultsUuids.get(data.testCaseStartedId)!;

    this.runtime.updateTest((result) => {
      result.status = result.steps.length > 0 ? getWorstStepResultStatus(result.steps) : Status.PASSED;
      result.stage = Stage.FINISHED;

      if (result.status === undefined) {
        result.statusDetails = {
          message: "The test doesn't have an implementation.",
        };
      }
    }, testUuid);
    this.runtime.stopTest({ uuid: testUuid, stop: Date.now() });
    this.runtime.writeTest(testUuid);
  }

  private onTestStepStarted(data: messages.TestStepStarted) {
    const testUuid = this.allureResultsUuids.get(data.testCaseStartedId)!;
    const step = this.testStepMap.get(data.testStepId)!;

    // TODO: support hooks reporting
    if (!step.pickleStepId) {
      return;
    }

    const stepPickle = this.pickleStepMap.get(step.pickleStepId)!;

    if (!stepPickle) {
      return;
    }

    const stepKeyword =
      stepPickle.astNodeIds
        .map((astNodeId) => this.stepMap.get(astNodeId))
        .map((stepAstNode) => stepAstNode?.keyword)
        .find((keyword) => keyword !== undefined) || "";
    const stepResult = {
      ...createStepResult(),
      name: `${stepKeyword}${stepPickle.text}`,
      start: data.timestamp.nanos,
    };

    this.runtime.startStep(stepResult, testUuid);

    if (!stepPickle.argument?.dataTable) {
      return;
    }

    const csvDataTable = stepPickle.argument.dataTable.rows.reduce(
      (acc, row) => `${acc + row.cells.map((cell) => cell.value).join(",")}\n`,
      "",
    );

    this.runtime.writeAttachment(
      {
        name: "Data table",
        content: csvDataTable,
        contentType: ContentType.CSV,
        encoding: "utf8",
      },
      testUuid,
    );
  }

  private onTestStepFinished(data: messages.TestStepFinished) {
    const testUuid = this.allureResultsUuids.get(data.testCaseStartedId)!;
    const currentStep = this.runtime.getCurrentStep(testUuid);

    // TODO: support hooks reporting
    if (!currentStep) {
      return;
    }

    this.runtime.updateStep((step) => {
      const status = this.parseStatus(data.testStepResult);

      step.status = status;
      step.stage = status !== Status.SKIPPED ? Stage.FINISHED : Stage.PENDING;

      if (status === undefined) {
        step.statusDetails = {
          message: "The step doesn't have an implementation.",
        };
        return;
      }

      if (data.testStepResult.exception) {
        step.statusDetails = {
          message: data.testStepResult.message,
          trace: data.testStepResult.exception.stackTrace,
        };
      }
    }, testUuid);

    this.runtime.stopStep({
      uuid: testUuid,
      stop: currentStep.start! + data.timestamp.nanos,
    });
  }

  private onHook(data: messages.Hook) {
    this.hookMap.set(data.id, data);
  }

  private onAttachment(message: messages.Attachment): void {
    if (!message.testCaseStartedId) {
      return;
    }

    const testUuid = this.allureResultsUuids.get(message.testCaseStartedId)!;

    if (message.mediaType === ALLURE_RUNTIME_MESSAGE_CONTENT_TYPE) {
      const parsedMessage = JSON.parse(message.body);

      this.runtime.applyRuntimeMessages(Array.isArray(parsedMessage) ? parsedMessage : [parsedMessage], {
        testUuid,
      });
      return;
    }

    // only pass through valid encodings
    const encoding = Buffer.isEncoding(message.contentEncoding) ? message.contentEncoding : "utf8";

    this.runtime.writeAttachment(
      {
        name: "Attachment",
        content: message.body,
        contentType: message.mediaType,
        encoding,
      },
      testUuid,
    );
  }
}
