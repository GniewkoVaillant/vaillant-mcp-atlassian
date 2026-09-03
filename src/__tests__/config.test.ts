import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOL_GROUPS, loadConfig, type ToolGroup } from "../config.js";

const ENV_FILE = fileURLToPath(new URL("./config-test.env", import.meta.url));
const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function writeEnv(contents: string): void {
  writeFileSync(ENV_FILE, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
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

  test("an empty value in the real environment overrides the .env file instead of falling back to it", () => {
    writeEnv(`
JIRA_BASE_URL=https://jira-from-file.example.test
JIRA_PAT=jira-from-file
CONFLUENCE_BASE_URL=https://confluence-from-file.example.test
CONFLUENCE_PAT=confluence-from-file
ATLASSIAN_ATTACHMENT_DIRS=/srv/attachments
`);
    // "Environment=ATLASSIAN_ATTACHMENT_DIRS=" in systemd, "-e ATLASSIAN_ATTACHMENT_DIRS=" in
    // Docker: an operator switching file access off must not get it switched on.
    process.env.ATLASSIAN_ATTACHMENT_DIRS = "";

    assert.deepEqual(loadConfig().attachmentDirs, []);
  });

  test("an empty override of a required value fails closed rather than using the .env value", () => {
    writeEnv(`
JIRA_BASE_URL=https://jira-from-file.example.test
JIRA_PAT=jira-from-file
CONFLUENCE_BASE_URL=https://confluence-from-file.example.test
CONFLUENCE_PAT=confluence-from-file
`);
    process.env.JIRA_PAT = "";

    assert.throws(() => loadConfig(), /Missing required environment variable\(s\): JIRA_PAT\./);
  });

  test("empty overrides of optional switches resolve to their documented defaults", () => {
    writeEnv(`
JIRA_BASE_URL=https://jira-from-file.example.test
JIRA_PAT=jira-from-file
CONFLUENCE_BASE_URL=https://confluence-from-file.example.test
CONFLUENCE_PAT=confluence-from-file
ATLASSIAN_PROFILE=core
ATLASSIAN_READ_ONLY=true
ATLASSIAN_TIMEOUT_MS=1234
`);
    process.env.ATLASSIAN_PROFILE = "";
    process.env.ATLASSIAN_READ_ONLY = "";
    process.env.ATLASSIAN_TIMEOUT_MS = "";

    const config = loadConfig();

    assert.deepEqual(groupNames(config.enabledGroups), [...ALL_TOOL_GROUPS].sort());
    assert.equal(config.readOnly, false);
    assert.equal(config.timeoutMs, 30_000);
  });

  test("refuses an environment file readable by other users", { skip: process.platform === "win32" }, (t) => {
    setRequiredEnv();
    chmodSync(ENV_FILE, 0o644);

    // chmod is a no-op on filesystems that do not carry POSIX permission bits
    // (FUSE mounts, network shares, Windows). Asserting on a mode the
    // filesystem silently refused to set is the one false alarm this suite
    // had, so check the effect instead of trusting the call.
    const groupAndOtherBits = statSync(ENV_FILE).mode & 0o077;
    if (groupAndOtherBits === 0) {
      t.skip("filesystem does not honour POSIX permission bits; nothing to detect");
      return;
    }

    assert.throws(() => loadConfig(), /accessible to other users.*chmod 600/);
  });

  test("requires HTTPS except for loopback development servers", () => {
    setRequiredEnv();
    process.env.JIRA_BASE_URL = "http://jira.example.test";
    assert.throws(() => loadConfig(), /JIRA_BASE_URL must use HTTPS/);

    process.env.JIRA_BASE_URL = "http://127.0.0.1:7010";
    assert.equal(loadConfig().jiraBaseUrl, "http://127.0.0.1:7010");
  });

  test("rejects base URLs with embedded credentials, queries or fragments", () => {
    setRequiredEnv();
    process.env.JIRA_BASE_URL = "https://user:password@jira.example.test";
    assert.throws(() => loadConfig(), /must not contain embedded credentials/);

    process.env.JIRA_BASE_URL = "https://jira.example.test/?unexpected=true";
    assert.throws(() => loadConfig(), /must not contain a query string or fragment/);
  });
});

describe("loadConfig profile parsing", () => {
  test("named profiles resolve to their group sets", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "ppm";

    assert.deepEqual(
      groupNames(loadConfig().enabledGroups),
      ["core", "files", "forms", "links", "meta", "users", "write"],
    );
  });

  test("the classic profile reproduces the pre-expansion surface", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "classic";

    // An existing deployment must be able to keep its old tools/list payload
    // without hand-maintaining a group list as new groups are added.
    assert.deepEqual(
      groupNames(loadConfig().enabledGroups),
      ["agile", "core", "dev", "files", "forms", "links", "write"],
    );
  });

  test("the full profile really means every group", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "full";

    assert.deepEqual(groupNames(loadConfig().enabledGroups), [...ALL_TOOL_GROUPS].sort());
  });

  test("the service profile exposes the service desk and the directory it needs", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "service";

    assert.deepEqual(groupNames(loadConfig().enabledGroups), ["core", "servicedesk", "users"]);
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

  test("the read profile enforces read-only mode even if its flag is explicitly false", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_PROFILE = "read";
    process.env.ATLASSIAN_READ_ONLY = "false";

    assert.equal(loadConfig().readOnly, true);
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

  test("destructive operations are disabled unless explicitly enabled", () => {
    setRequiredEnv();
    assert.equal(loadConfig().allowDestructive, false);

    process.env.ATLASSIAN_ALLOW_DESTRUCTIVE = "true";
    assert.equal(loadConfig().allowDestructive, true);
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

  test("ATLASSIAN_ATTACHMENT_DIRS splits on the platform delimiter and drops empty entries", () => {
    setRequiredEnv();
    assert.deepEqual(loadConfig().attachmentDirs, []);

    // Built from path.delimiter rather than a hard-coded ":". The colon is not
    // a separator on Windows — it is part of every absolute path there
    // ("C:\\data") — which is exactly why the loader splits on path.delimiter.
    // Hard-coding ":" made this test assert POSIX behaviour and fail against
    // correct Windows behaviour, which is a false negative in the worst
    // direction: it reports a defect where there is none, and would hide a real
    // one behind noise.
    const directories = process.platform === "win32"
      ? ["C:\\one", "C:\\two", "C:\\three"]
      : ["/one", "/two", "/three"];
    const [first, second, third] = directories;

    // Surrounding whitespace, a doubled delimiter and a trailing space are all
    // things an operator really types; each must be tolerated.
    process.env.ATLASSIAN_ATTACHMENT_DIRS =
      ` ${first} ${delimiter}${second}${delimiter}${delimiter} ${third} `;
    assert.deepEqual(loadConfig().attachmentDirs, directories);
  });

  test("attachment allowlists reject relative directories and the filesystem root", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_ATTACHMENT_DIRS = "relative/path";
    assert.throws(() => loadConfig(), /Use an absolute directory other than the filesystem root/);

    process.env.ATLASSIAN_ATTACHMENT_DIRS = "/";
    assert.throws(() => loadConfig(), /Use an absolute directory other than the filesystem root/);
  });

  test("resource protection defaults are bounded and configurable", () => {
    setRequiredEnv();
    const defaults = loadConfig();
    assert.equal(defaults.totalTimeoutMs, 45_000);
    assert.equal(defaults.maxConcurrentRequests, 4);
    assert.equal(defaults.maxQueuedRequests, 16);
    assert.equal(defaults.maxAttachmentBytes, 10 * 1024 * 1024);
    assert.equal(defaults.maxPaginationPages, 10);

    process.env.ATLASSIAN_TOTAL_TIMEOUT_MS = "12000";
    process.env.ATLASSIAN_MAX_CONCURRENT_REQUESTS = "2";
    process.env.ATLASSIAN_MAX_QUEUED_REQUESTS = "0";
    process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES = "4096";
    process.env.ATLASSIAN_MAX_PAGINATION_PAGES = "3";
    const configured = loadConfig();
    assert.equal(configured.totalTimeoutMs, 12_000);
    assert.equal(configured.maxConcurrentRequests, 2);
    assert.equal(configured.maxQueuedRequests, 0);
    assert.equal(configured.maxAttachmentBytes, 4096);
    assert.equal(configured.maxPaginationPages, 3);
  });

  test("JSON and tool-result budgets default, accept overrides and fail closed on junk", () => {
    setRequiredEnv();
    const defaults = loadConfig();
    assert.equal(defaults.maxJsonBytes, 16 * 1024 * 1024);
    assert.equal(defaults.maxToolResultBytes, 150_000);

    process.env.ATLASSIAN_MAX_JSON_BYTES = "2048";
    process.env.ATLASSIAN_MAX_TOOL_RESULT_BYTES = "4096";
    const configured = loadConfig();
    assert.equal(configured.maxJsonBytes, 2048);
    assert.equal(configured.maxToolResultBytes, 4096);

    for (const junk of ["abc", "0", "-1", "1.5"]) {
      process.env.ATLASSIAN_MAX_JSON_BYTES = junk;
      assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_JSON_BYTES/);
    }
    delete process.env.ATLASSIAN_MAX_JSON_BYTES;

    for (const junk of ["abc", "0", "-1", "1.5"]) {
      process.env.ATLASSIAN_MAX_TOOL_RESULT_BYTES = junk;
      assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_TOOL_RESULT_BYTES/);
    }
  });

  test("both new budgets reject values above their ceiling", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_MAX_JSON_BYTES = String(256 * 1024 * 1024 + 1);
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_JSON_BYTES/);

    delete process.env.ATLASSIAN_MAX_JSON_BYTES;
    process.env.ATLASSIAN_MAX_TOOL_RESULT_BYTES = String(16 * 1024 * 1024 + 1);
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_TOOL_RESULT_BYTES/);
  });

  test("resource limits reject fractional, negative and excessive values", () => {
    setRequiredEnv();
    process.env.ATLASSIAN_MAX_CONCURRENT_REQUESTS = "1.5";
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_CONCURRENT_REQUESTS/);

    delete process.env.ATLASSIAN_MAX_CONCURRENT_REQUESTS;
    process.env.ATLASSIAN_MAX_QUEUED_REQUESTS = "-1";
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_QUEUED_REQUESTS/);

    delete process.env.ATLASSIAN_MAX_QUEUED_REQUESTS;
    process.env.ATLASSIAN_MAX_PAGINATION_PAGES = "101";
    assert.throws(() => loadConfig(), /Invalid ATLASSIAN_MAX_PAGINATION_PAGES/);
  });
});
