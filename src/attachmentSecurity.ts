/**
 * Filesystem-safety helpers shared by the Jira and Confluence attachment
 * paths. This is the code that guards against path traversal, symlink escape
 * and TOCTOU races, so it deliberately lives in exactly one place: a fix or a
 * hardening applied here reaches both clients at once.
 */
import { constants as fileConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** Default ceiling for attachment uploads and downloads, in bytes. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * The subset of client options these helpers need. Both `ClientOptions`
 * interfaces are structurally assignable to it, so callers pass `this.options`
 * directly.
 */
export interface AttachmentPolicy {
    /**
     * Absolute directories that attachment download/upload may touch. An empty
     * or omitted list disables filesystem access entirely, which is the safe
     * default: issue and page content is written by other people, so a crafted
     * ticket must not be able to talk the agent into reading arbitrary local
     * files.
     */
    attachmentDirs?: string[];
    /** Maximum number of bytes accepted for attachment uploads and downloads. */
    maxAttachmentBytes?: number;
}

/** Resolve existing ancestors physically before checking allowlist containment. */
export async function assertAttachmentPathAllowed(
    policy: AttachmentPolicy,
    candidate: string,
    label: string,
    mustExist = false,
): Promise<string> {
    if (!isAbsolute(candidate)) {
        throw new Error(`Attachment ${label} must be an absolute path`);
    }
    const allowed = policy.attachmentDirs ?? [];
    if (allowed.length === 0) {
        throw new Error(
            "Attachment access is disabled. Set ATLASSIAN_ATTACHMENT_DIRS to a " +
                "list of directories separated by the platform path delimiter " +
                '(":" on Linux/macOS, ";" on Windows) to enable it.',
        );
    }
    const resolved = resolve(candidate);
    if (!mustExist) {
        try {
            const existing = await lstat(resolved);
            if (existing.isSymbolicLink()) {
                throw new Error(`Attachment ${label} must not be a symbolic link.`);
            }
            throw new Error(`Attachment ${label} "${resolved}" already exists; refusing to overwrite it.`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }

    let existingAncestor = resolved;
    const missingSegments: string[] = [];
    let canonical: string;
    while (true) {
        try {
            canonical = resolve(await realpath(existingAncestor), ...missingSegments);
            break;
        } catch (error) {
            if (mustExist || (error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor) {
                throw error;
            }
            missingSegments.unshift(basename(existingAncestor));
            existingAncestor = parent;
        }
    }

    const roots = await Promise.all(allowed.map((dir) => realpath(resolve(dir))));
    const permitted = roots.some((root) => {
        const rel = relative(root, canonical);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!permitted) {
        throw new Error(
            `Attachment ${label} "${canonical}" is outside the allowed directories ` +
                `(${allowed.join(", ")}).`,
        );
    }
    return canonical;
}

export function assertAttachmentSize(policy: AttachmentPolicy, size: number, source: string): void {
    const maximum = policy.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (size > maximum) {
        throw new Error(
            `Attachment ${source} is ${size} bytes, exceeding the ${maximum}-byte ` +
                "ATLASSIAN_MAX_ATTACHMENT_BYTES limit.",
        );
    }
}

export async function writeNewAttachment(
    policy: AttachmentPolicy,
    outputPath: string,
    data: Uint8Array,
): Promise<void> {
    // Validate before mkdir: an outputPath outside the allowlist must never create
    // directories as a side effect. The second call below is the load-bearing one --
    // it re-resolves the path physically once the ancestors exist, so a symlinked
    // ancestor still trips the verifiedPath !== outputPath check.
    await assertAttachmentPathAllowed(policy, outputPath, "outputPath");
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const verifiedPath = await assertAttachmentPathAllowed(policy, outputPath, "outputPath");
    if (verifiedPath !== outputPath) {
        throw new Error("Attachment outputPath changed during validation.");
    }
    const handle = await open(
        verifiedPath,
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY | fileConstants.O_NOFOLLOW,
        0o600,
    );
    try {
        await handle.writeFile(data);
    } finally {
        await handle.close();
    }
}

/**
 * Opens an existing attachment for upload without following symlinks, checks
 * it is a regular file, and enforces the size ceiling both before and after
 * reading it.
 */
export async function readExistingAttachment(
    policy: AttachmentPolicy,
    filePath: string,
): Promise<{ path: string; data: Buffer }> {
    const safeFilePath = await assertAttachmentPathAllowed(policy, filePath, "filePath", true);
    const handle = await open(safeFilePath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
    let data: Buffer;
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
            throw new Error("Attachment filePath must point to a regular file.");
        }
        assertAttachmentSize(policy, metadata.size, "upload size");
        data = await handle.readFile();
    } finally {
        await handle.close();
    }
    assertAttachmentSize(policy, data.byteLength, "upload size");
    return { path: safeFilePath, data };
}
