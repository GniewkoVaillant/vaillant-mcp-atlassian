import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAttachmentPathAllowed,
  assertAttachmentSize,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  readExistingAttachment,
  writeNewAttachment,
  type AttachmentPolicy,
} from "../attachmentSecurity.js";

/**
 * One shared suite for the filesystem-safety helpers both clients delegate to.
 * The per-client test files keep only the integration checks proving the client
 * actually routes through these functions.
 */
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "attachment-security-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  directory = "";
});

function policy(overrides: AttachmentPolicy = {}): AttachmentPolicy {
  return { attachmentDirs: [directory], ...overrides };
}

describe("assertAttachmentPathAllowed", () => {
  test("rejects relative paths and names the caller-supplied label", async () => {
    await assert.rejects(
      assertAttachmentPathAllowed(policy(), "relative/file.txt", "outputPath"),
      /^Error: Attachment outputPath must be an absolute path$/,
    );
    await assert.rejects(
      assertAttachmentPathAllowed(policy(), "relative/file.txt", "filePath"),
      /^Error: Attachment filePath must be an absolute path$/,
    );
  });

  test("refuses every path when no attachment directories are configured", async () => {
    const target = join(directory, "file.txt");

    await assert.rejects(
      assertAttachmentPathAllowed({}, target, "outputPath"),
      /Attachment access is disabled\. Set ATLASSIAN_ATTACHMENT_DIRS to a list of directories separated by the platform path delimiter \(":" on Linux\/macOS, ";" on Windows\) to enable it\./,
    );
    await assert.rejects(
      assertAttachmentPathAllowed({ attachmentDirs: [] }, target, "outputPath"),
      /Attachment access is disabled/,
    );
  });

  test("rejects a path outside the allowlist and reports the configured roots", async () => {
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);

    await assert.rejects(
      assertAttachmentPathAllowed({ attachmentDirs: [allowed] }, join(outside, "file.txt"), "outputPath"),
      new RegExp(`is outside the allowed directories \\(${allowed}\\)\\.$`),
    );
  });

  test("rejects traversal through a directory symlink that escapes the allowlist", async () => {
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, join(allowed, "escape"), "dir");

    await assert.rejects(
      assertAttachmentPathAllowed({ attachmentDirs: [allowed] }, join(allowed, "escape", "capture.txt"), "outputPath"),
      /outside the allowed directories/,
    );
  });

  test("rejects a symbolic-link destination", async () => {
    const existing = join(directory, "existing.txt");
    const link = join(directory, "link.txt");
    await writeFile(existing, "preserve this fixture");
    await symlink(existing, link);

    await assert.rejects(
      assertAttachmentPathAllowed(policy(), link, "outputPath"),
      /^Error: Attachment outputPath must not be a symbolic link\.$/,
    );
  });

  test("refuses to overwrite an existing destination", async () => {
    const existing = join(directory, "existing.txt");
    await writeFile(existing, "preserve this fixture");

    await assert.rejects(
      assertAttachmentPathAllowed(policy(), existing, "outputPath"),
      new RegExp(`^Error: Attachment outputPath "${existing}" already exists; refusing to overwrite it\\.$`),
    );
    assert.equal(await readFile(existing, "utf8"), "preserve this fixture");
  });

  test("accepts a not-yet-existing path whose missing ancestors stay inside the allowlist", async () => {
    const canonical = await assertAttachmentPathAllowed(policy(), join(directory, "nested", "deeper", "file.txt"), "outputPath");

    assert.equal(canonical.endsWith(join("nested", "deeper", "file.txt")), true);
    await assert.rejects(stat(join(directory, "nested")), { code: "ENOENT" });
  });

  test("canonicalizes an allowlisted symlinked parent instead of rejecting it", async () => {
    const real = join(directory, "real");
    const link = join(directory, "link");
    await mkdir(real);
    await symlink(real, link, "dir");

    const canonical = await assertAttachmentPathAllowed(policy(), join(link, "file.txt"), "outputPath");

    assert.equal(canonical, join(await realpathOf(real), "file.txt"));
  });

  test("with mustExist skips the overwrite and symlink checks and requires the path to resolve", async () => {
    const existing = join(directory, "upload.txt");
    await writeFile(existing, "payload");

    // An existing regular file is accepted rather than rejected as "already exists".
    assert.equal(await assertAttachmentPathAllowed(policy(), existing, "filePath", true), await realpathOf(existing));
    // A missing path surfaces the raw ENOENT instead of walking up to the parent.
    await assert.rejects(assertAttachmentPathAllowed(policy(), join(directory, "missing.txt"), "filePath", true), {
      code: "ENOENT",
    });
  });

  test("with mustExist still enforces the allowlist for an existing file", async () => {
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(outside, "synthetic.txt"), "synthetic fixture");
    await symlink(join(outside, "synthetic.txt"), join(allowed, "escape.txt"));

    await assert.rejects(
      assertAttachmentPathAllowed({ attachmentDirs: [allowed] }, join(allowed, "escape.txt"), "filePath", true),
      /Attachment filePath ".*" is outside the allowed directories/,
    );
  });
});

describe("assertAttachmentSize", () => {
  test("accepts sizes up to and including the configured maximum", () => {
    assertAttachmentSize({ maxAttachmentBytes: 4 }, 0, "declared size");
    assertAttachmentSize({ maxAttachmentBytes: 4 }, 4, "declared size");
  });

  test("rejects oversized payloads and names the source and the limit", () => {
    assert.throws(
      () => assertAttachmentSize({ maxAttachmentBytes: 4 }, 5, "download size"),
      /^Error: Attachment download size is 5 bytes, exceeding the 4-byte ATLASSIAN_MAX_ATTACHMENT_BYTES limit\.$/,
    );
    assert.throws(
      () => assertAttachmentSize({ maxAttachmentBytes: 4 }, 5, "upload size"),
      /Attachment upload size is 5 bytes, exceeding the 4-byte/,
    );
  });

  test("falls back to the 10 MiB default when no maximum is configured", () => {
    assert.equal(DEFAULT_MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
    assertAttachmentSize({}, DEFAULT_MAX_ATTACHMENT_BYTES, "declared size");
    assert.throws(
      () => assertAttachmentSize({}, DEFAULT_MAX_ATTACHMENT_BYTES + 1, "declared size"),
      new RegExp(`exceeding the ${DEFAULT_MAX_ATTACHMENT_BYTES}-byte`),
    );
  });
});

describe("writeNewAttachment", () => {
  test("creates missing parents and writes an owner-only file", async () => {
    const nested = join(directory, "nested");
    const outputPath = join(nested, "file.txt");

    await writeNewAttachment(policy(), outputPath, new TextEncoder().encode("safe"));

    assert.equal(await readFile(outputPath, "utf8"), "safe");
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal((await stat(nested)).mode & 0o777, 0o700);
  });

  test("refuses to overwrite a file created between validation and open", async () => {
    const outputPath = join(directory, "race.txt");
    await writeFile(outputPath, "concurrent fixture");

    await assert.rejects(
      writeNewAttachment(policy(), outputPath, new TextEncoder().encode("safe")),
      /already exists; refusing to overwrite/,
    );
    assert.equal(await readFile(outputPath, "utf8"), "concurrent fixture");
  });

  test("refuses a destination outside the allowlist without writing anything", async () => {
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    const outputPath = join(outside, "capture.txt");

    await assert.rejects(
      writeNewAttachment({ attachmentDirs: [allowed] }, outputPath, new TextEncoder().encode("safe")),
      /outside the allowed directories/,
    );
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
  });

  test("creates no directories at all for a destination outside the allowlist", async () => {
    const allowed = join(directory, "allowed");
    await mkdir(allowed);
    const escapeRoot = join(directory, "outside");
    const outputPath = join(escapeRoot, "deep", "nested", "capture.txt");

    await assert.rejects(
      writeNewAttachment({ attachmentDirs: [allowed] }, outputPath, new TextEncoder().encode("safe")),
      /outside the allowed directories/,
    );
    // Validation must run before mkdir, so not even the parent chain may appear.
    await assert.rejects(stat(escapeRoot), { code: "ENOENT" });
  });

  test("refuses to write when canonicalization moved the destination", async () => {
    const real = join(directory, "real");
    const link = join(directory, "link");
    await mkdir(real);
    await symlink(real, link, "dir");
    const outputPath = join(link, "file.txt");

    await assert.rejects(
      writeNewAttachment(policy(), outputPath, new TextEncoder().encode("safe")),
      /^Error: Attachment outputPath changed during validation\.$/,
    );
    await assert.rejects(stat(join(real, "file.txt")), { code: "ENOENT" });
  });
});

describe("readExistingAttachment", () => {
  test("returns the canonical path and the file contents", async () => {
    const file = join(directory, "upload.txt");
    await writeFile(file, "payload");

    const result = await readExistingAttachment(policy(), file);

    assert.equal(result.path, await realpathOf(file));
    assert.equal(result.data.toString("utf8"), "payload");
  });

  test("rejects a path that is not a regular file", async () => {
    const nested = join(directory, "nested");
    await mkdir(nested);

    await assert.rejects(
      readExistingAttachment(policy(), nested),
      /^Error: Attachment filePath must point to a regular file\.$/,
    );
  });

  test("rejects a missing file", async () => {
    await assert.rejects(readExistingAttachment(policy(), join(directory, "missing.txt")), { code: "ENOENT" });
  });

  test("rejects a symlink resolving outside the allowlist", async () => {
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(outside, "synthetic.txt"), "synthetic fixture");
    await symlink(join(outside, "synthetic.txt"), join(allowed, "escape.txt"));

    await assert.rejects(
      readExistingAttachment({ attachmentDirs: [allowed] }, join(allowed, "escape.txt")),
      /outside the allowed directories/,
    );
  });

  test("rejects a file above the configured size ceiling", async () => {
    const file = join(directory, "oversized.txt");
    await writeFile(file, "12345");

    await assert.rejects(
      readExistingAttachment(policy({ maxAttachmentBytes: 4 }), file),
      /Attachment upload size is 5 bytes, exceeding the 4-byte/,
    );
  });

  // Regression coverage for the file *types* O_NOFOLLOW does not cover. Before the
  // pre-open lstat, open(O_RDONLY) on a writer-less FIFO blocked in the kernel
  // forever, so every case below is raced against a timeout: a hang must surface as
  // a failing assertion rather than as a suite that never finishes.
  test("rejects a FIFO promptly instead of blocking forever in open()", async () => {
    const fifo = join(directory, "pipe.fifo");
    makeFifo(fifo);

    await assert.rejects(
      withDeadline(readExistingAttachment(policy(), fifo), "readExistingAttachment on a FIFO"),
      /^Error: Attachment filePath must point to a regular file\.$/,
    );
  });

  test("keeps unrelated filesystem I/O alive after more FIFO attempts than libuv has threads", async () => {
    // UV_THREADPOOL_SIZE defaults to 4; six blocked opens used to wedge the whole
    // process, including reads of ordinary files that never touched this module.
    const fifos = Array.from({ length: 6 }, (_unused, index) => join(directory, `pipe-${index}.fifo`));
    for (const fifo of fifos) {
      makeFifo(fifo);
    }
    const witness = join(directory, "witness.txt");
    await writeFile(witness, "threadpool still healthy");

    await Promise.all(
      fifos.map((fifo) =>
        assert.rejects(
          withDeadline(readExistingAttachment(policy(), fifo), `readExistingAttachment on ${fifo}`),
          /must point to a regular file/,
        ),
      ),
    );

    assert.equal(await withDeadline(readFile(witness, "utf8"), "plain readFile"), "threadpool still healthy");
  });

  test("rejects a unix domain socket promptly", async () => {
    const socketPath = join(directory, "listener.sock");
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    try {
      await assert.rejects(
        withDeadline(readExistingAttachment(policy(), socketPath), "readExistingAttachment on a socket"),
        /^Error: Attachment filePath must point to a regular file\.$/,
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  test("rejects a character device promptly", async () => {
    await assert.rejects(
      withDeadline(readExistingAttachment({ attachmentDirs: ["/dev"] }, "/dev/null"), "character device"),
      /^Error: Attachment filePath must point to a regular file\.$/,
    );
  });

  test("refuses a hard link into the allowlist without returning the linked file's bytes", async () => {
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "credentials that must never reach Jira");
    const innocent = join(allowed, "innocent.txt");
    // realpath() reports an allowlisted path and isFile() passes: only nlink betrays
    // that these bytes were created outside the allowed directories.
    await link(secret, innocent);

    let leaked: string | undefined;
    await assert.rejects(
      (async () => {
        leaked = (await readExistingAttachment({ attachmentDirs: [allowed] }, innocent)).data.toString("utf8");
      })(),
      /^Error: Attachment filePath has 2 hard links, so the same file is also reachable under another name that may sit outside the allowed directories; refusing to read it\.$/,
    );
    assert.equal(leaked, undefined);
    assert.equal(await readFile(secret, "utf8"), "credentials that must never reach Jira");
  });

  test("refuses a hard link even when both names sit inside the allowlist", async () => {
    // Conservative on purpose: nothing in stat() says where the other name lives.
    const original = join(directory, "upload.txt");
    await writeFile(original, "payload");
    await link(original, join(directory, "alias.txt"));

    await assert.rejects(readExistingAttachment(policy(), original), /hard links/);
  });
});

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

/**
 * Fails instead of hanging. A regression of the FIFO defect makes the underlying
 * open() never return, which would otherwise stall the whole test run.
 */
async function withDeadline<T>(operation: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms`)), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** macOS resolves the temporary directory through /private, so compare canonically. */
async function realpathOf(target: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(target);
}
