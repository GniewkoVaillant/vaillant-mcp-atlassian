import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type ToolGroup } from "../config.js";

const ENV_FILE = fileURLToPath(new URL("./config-test.env", import.meta.url));
const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function writeEnv(contents: string): void {
  writeFileSync(ENV_FILE, contents, "utf8");
  process.env.ATLASSIAN_ENV_FILE = ENV_FILE;
}

function setRequiredEnv(): void {
  process.env.JIRA_BASE_URL = "https://jira.example.test";
  process.env.JIRA_PAT = "jira-token";
  process.env.CONFLUENCE_BASE_URL = "https://confluence.example.test";
  process.env.CONFLUENCE_PAT = "confluence-token";
}

function groupNames(groups: Set<ToolGroup>): string[] {
  return [...groups].sort();
}

beforeEach(() => {
  restoreEnv();
  rmSync(ENV_FILE, { force: true });
  writeEnv("");
});

afterEach(() => {
  restoreEnv();
  rmSync(ENV_FILE, { force: true });
});

describe("loadConfig required values and .env loading", () => {
  test("missing required variables produce one error naming all missing variables", () => {
    assert.throws(
      () => loadConfig(),
      /Missing required environment variable\(s\): JIRA_BASE_URL, JIRA_PAT, CONFLUENCE_BASE_URL, CONFLUENCE_PAT\./,
    );
  });

  test("strips trailing slashes from base URLs", () => {
    setRequiredEnv();
    process.env.JIRA_BASE_URL = "https://jira.example.test/";
    process.env.CONFLUENCE_BASE_URL = "https://confluence.example.test/";

    const config = loadConfig();

    assert.equal(config.jiraBaseUrl, "https://jira.example.test");
    assert.equal(config.confluenceBaseUrl, "https://confluence.example.test");
  });

  test("loads .env values, unquotes quoted values, ignores comments and blanks, and lets real environment win", () => {
    writeEnv(`
# comment
JIRA_BASE_URL=https://jira-from-file.example.test/
JIRA_PAT="jira from file"
CONFLUENCE_BASE_URL='https://confluence-from-file.example.test/'
CONFLUENCE_PAT=confluence-from-file
ATLASSIAN_TIMEOUT_MS=45000
`);
    process.env.JIRA_PAT = "jira from env";

    const config = loadConfig();

    assert.equal(config.envFile, ENV_FILE);
    assert.equal(config.jiraBaseUrl, "https://jira-from-file.example.test");
    assert.equal(config.jiraPat, "jira from env");
    assert.equal(config.confluenceBaseUrl, "https://confluence-from-file.example.test");
    assert.equal(config.confluencePat, "confluence-from-file");
    assert.equal(config.timeoutMs, 45000);
  });
});

describe("loadConfig profile parsing", () => {
  test("named profiles resolve to their group sets", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "ppm";

    assert.deepEqual(groupNames(loadConfig().enabledGroups), ["core", "files", "forms", "links", "write"]);
  });

  test("comma-separated raw groups work and always include core", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "forms,dev";

    assert.deepEqual(groupNames(loadConfig().enabledGroups), ["core", "dev", "forms"]);
  });

  test("unknown groups throw", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "forms,nope";

    assert.throws(() => loadConfig(), /Unknown tool group "nope" in ATLASSIAN_PROFILE/);
  });
});

describe("loadConfig scalar parsing", () => {
  test("ATLASSIAN_READ_ONLY accepts true, false, 1, 0, yes and no", () => {
    setRequiredEnv();

    for (const [raw, expected] of [["true", true], ["false", false], ["1", true], ["0", false], ["yes", true], ["no", false]] as const) {
      process.env.ATLASSIAN_READ_ONLY = raw;
      assert.equal(loadConfig().readOnly, expected);
    }
  });

  test("ATLASSIAN_READ_ONLY throws on nonsense", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_READ_ONLY = "maybe";

    assert.throws(() => loadConfig(), /Invalid boolean value "maybe"\. Use true\/false\./);
  });

  test("ATLASSIAN_TIMEOUT_MS defaults to 30000 and accepts a positive number", () => {
    setRequiredEnv();
    assert.equal(loadConfig().timeoutMs, 30000);

    process.env.ATLASSIAN_TIMEOUT_MS = "1234";
    assert.equal(loadConfig().timeoutMs, 1234);
  });

  test("ATLASSIAN_TIMEOUT_MS throws on non-numeric or non-positive values", () => {
    setRequiredEnv();

    process.env.ATLASSIAN_TIMEOUT_MS = "abc";
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_TIMEOUT_MS "abc"/);

    process.env.ATLASSIAN_TIMEOUT_MS = "0";
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_TIMEOUT_MS "0"/);
  });

  test("ATLASSIAN_ATTACHMENT_DIRS splits on colon and empty values yield an empty array", () => {
    setRequiredEnv();
    assert.deepEqual(loadConfig().attachmentDirs, []);

    process.env.ATLASSIAN_ATTACHMENT_DIRS = " /one :/two:: /three ";
    assert.deepEqual(loadConfig().attachmentDirs, ["/one", "/two", "/three"]);
  });
});
