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
    return root.rawData ? parseChunkPosition(root.rawData.part).total : 0;
}
export function decodeProformaDesign(root: ProformaRoot, additionalChunks: ProformaRawDataChunk[]): any {
    const chunks = root.rawData ? [root.rawData, ...additionalChunks] : additionalChunks;
    if (chunks.length === 0) {
        return root.design || {};
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
    return {
        ...(root.design || {}),
        ...decoded,
        questions: {
            ...(root.design?.questions || {}),
            ...(decoded.questions || {}),
        },
    };
}
export function formatProformaAnswer(answer: any, question: any): string {
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
