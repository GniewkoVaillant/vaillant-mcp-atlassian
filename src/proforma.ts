export interface ProformaRawDataChunk {
    part: string;
    data: string;
}

export interface ProformaRoot {
    rawData?: ProformaRawDataChunk;
    design?: any;
    state?: any;
}

interface ProformaChunkPosition {
    current: number;
    total: number;
}

/** Short, safe description of an unexpected value, for use in error messages. */
function describeValue(value: unknown): string {
    if (value === null)
        return "null";
    if (value === undefined)
        return "no value";
    if (Array.isArray(value))
        return "an array";
    return `a value of type ${typeof value}`;
}

/**
 * Gate for data that reached us from Jira. ProForma keeps its forms in issue
 * properties, and Data Center happily returns `null` for a property that was
 * cleared but never deleted; without this the first property access throws a
 * bare TypeError that names neither the form nor the issue.
 */
function assertProformaRoot(root: unknown): asserts root is ProformaRoot {
    if (!root || typeof root !== "object" || Array.isArray(root)) {
        throw new Error(`Invalid ProForma form data: expected an object, received ${describeValue(root)}.`);
    }
    const rawData = (root as ProformaRoot).rawData;
    if (rawData === undefined || rawData === null)
        return;
    if (typeof rawData !== "object" ||
        Array.isArray(rawData) ||
        typeof (rawData as ProformaRawDataChunk).part !== "string" ||
        typeof (rawData as ProformaRawDataChunk).data !== "string") {
        throw new Error("Invalid ProForma raw-data chunk: expected an object with string " +
            `"part" and "data", received ${describeValue(rawData)}.`);
    }
}

/** Accepts an optional object-valued member, rejecting anything else by name. */
function asPlainObject(value: unknown, label: string): Record<string, any> {
    if (value === undefined || value === null)
        return {};
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid ProForma ${label}: expected an object, received ${describeValue(value)}.`);
    }
    return value as Record<string, any>;
}

function parseChunkPosition(part: string): ProformaChunkPosition {
    const match = /^(\d+)\/(\d+)$/.exec(part);
    if (!match) {
        throw new Error(`Invalid ProForma raw-data chunk marker: ${part}`);
    }
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (current < 1 || total < 1 || current > total) {
        throw new Error(`Invalid ProForma raw-data chunk position: ${part}`);
    }
    return { current, total };
}
export function getProformaChunkCount(root: ProformaRoot): number {
    assertProformaRoot(root);
    return root.rawData ? parseChunkPosition(root.rawData.part).total : 0;
}
export function decodeProformaDesign(root: ProformaRoot, additionalChunks: ProformaRawDataChunk[]): any {
    assertProformaRoot(root);
    if (!Array.isArray(additionalChunks)) {
        throw new Error("Invalid ProForma raw-data chunk list: expected an array, received " +
            `${describeValue(additionalChunks)}.`);
    }
    for (const chunk of additionalChunks) {
        if (!chunk || typeof chunk !== "object" || Array.isArray(chunk) ||
            typeof chunk.part !== "string" || typeof chunk.data !== "string") {
            throw new Error("Invalid ProForma raw-data chunk: expected an object with string " +
                `"part" and "data", received ${describeValue(chunk)}.`);
        }
    }
    const chunks = root.rawData ? [root.rawData, ...additionalChunks] : additionalChunks;
    if (chunks.length === 0) {
        return asPlainObject(root.design, "form design");
    }
    const positioned = chunks.map((chunk: ProformaRawDataChunk) => ({
        chunk,
        ...parseChunkPosition(chunk.part),
    }));
    const expectedTotal = positioned[0].total;
    if (positioned.some(({ total }) => total !== expectedTotal)) {
        throw new Error("ProForma raw-data chunks declare inconsistent totals");
    }
    const byPosition = new Map(positioned.map((item) => [item.current, item.chunk]));
    if (byPosition.size !== expectedTotal) {
        throw new Error(`Incomplete ProForma raw data: received ${byPosition.size} of ${expectedTotal} chunks`);
    }
    const encoded = Array.from({ length: expectedTotal }, (_, index) => {
        const chunk = byPosition.get(index + 1);
        if (!chunk) {
            throw new Error(`Missing ProForma raw-data chunk ${index + 1}/${expectedTotal}`);
        }
        return chunk.data;
    }).join("");
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    }
    catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to decode ProForma form design: ${cause}`);
    }
    const design = asPlainObject(root.design, "form design");
    const decodedDesign = asPlainObject(decoded, "decoded form design");
    return {
        ...design,
        ...decodedDesign,
        questions: {
            ...asPlainObject(design.questions, "form design questions"),
            ...asPlainObject(decodedDesign.questions, "decoded form design questions"),
        },
    };
}
/**
 * Renders one stored answer as the human-readable text a caller sees.
 *
 * The value comes straight out of the form state, where ProForma stores
 * whatever the field type produced - an object for most fields, but also bare
 * strings, numbers and lists, and `null` for a question whose field was
 * deleted. Everything therefore has to be discriminated by type before it is
 * fed to `Object.entries`, which would otherwise take a string apart into its
 * characters and an array apart into its indices.
 */
export function formatProformaAnswer(answer: any, question: any): string {
    if (answer === null || answer === undefined)
        return "";
    if (typeof answer === "string")
        return answer.trim();
    if (typeof answer === "number" || typeof answer === "boolean")
        return String(answer);
    if (Array.isArray(answer))
        return formatAnswerList(answer);
    if (typeof answer !== "object")
        return "";
    const parts: string[] = [];
    const text = typeof answer.text === "string" ? answer.text.trim() : "";
    if (text)
        parts.push(text);
    if (Array.isArray(answer.choices)) {
        const labels = answer.choices.map((choiceId: any) => {
            const match = question?.choices?.find((choice: any) => String(choice.id) === String(choiceId));
            return match?.label || String(choiceId);
        });
        if (labels.length > 0)
            parts.push(labels.join(", "));
    }
    for (const [key, value] of Object.entries(answer)) {
        if (key === "text" || key === "choices")
            continue;
        if (typeof value === "string" && value.trim())
            parts.push(value.trim());
        if (typeof value === "number" || typeof value === "boolean")
            parts.push(String(value));
    }
    if (parts.length > 0)
        return parts.join(" | ");
    const remaining = Object.fromEntries(Object.entries(answer).filter(([key, value]) => {
        if (key === "text" || key === "choices")
            return false;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            return false;
        }
        if (value === null || value === undefined || value === "")
            return false;
        return !Array.isArray(value) || value.length > 0;
    }));
    return Object.keys(remaining).length > 0 ? JSON.stringify(remaining) : "";
}

/** Formats a bare list answer, keeping element structure instead of indices. */
function formatAnswerList(values: any[]): string {
    return values
        .map((value: any) => {
            if (value === null || value === undefined)
                return "";
            if (typeof value === "string")
                return value.trim();
            if (typeof value === "number" || typeof value === "boolean")
                return String(value);
            try {
                return JSON.stringify(value) ?? "";
            }
            catch {
                return "";
            }
        })
        .filter((part: string) => part !== "")
        .join(", ");
}
