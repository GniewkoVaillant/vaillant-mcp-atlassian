import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeProformaDesign,
  formatProformaAnswer,
  getProformaChunkCount,
  type ProformaRawDataChunk,
} from "../proforma.js";

function chunksFor(payload: unknown, total: number): ProformaRawDataChunk[] {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const size = Math.ceil(encoded.length / total);
  return Array.from({ length: total }, (_, index) => ({
    part: `${index + 1}/${total}`,
    data: encoded.slice(index * size, index === total - 1 ? undefined : (index + 1) * size),
  }));
}

describe("ProForma raw-data decoding", () => {
  test("getProformaChunkCount reads the total from the part marker and returns 0 without rawData", () => {
    assert.equal(getProformaChunkCount({ rawData: { part: "1/3", data: "" } }), 3);
    assert.equal(getProformaChunkCount({ design: { title: "No chunks" } }), 0);
  });

  test("decodeProformaDesign reassembles and decodes chunks supplied out of order", () => {
    const [first, second, third] = chunksFor({ title: "Decoded", questions: { q1: { label: "One" } } }, 3);
    const result = decodeProformaDesign({ rawData: first }, [third, second]);

    assert.deepEqual(result, { title: "Decoded", questions: { q1: { label: "One" } } });
  });

  test("decodeProformaDesign throws when chunks declare inconsistent totals", () => {
    assert.throws(
      () => decodeProformaDesign({ rawData: { part: "1/2", data: "" } }, [{ part: "2/3", data: "" }]),
      /ProForma raw-data chunks declare inconsistent totals/,
    );
  });

  test("decodeProformaDesign throws when the chunk set is incomplete", () => {
    const [first] = chunksFor({ title: "Missing" }, 3);

    assert.throws(
      () => decodeProformaDesign({ rawData: first }, []),
      /Incomplete ProForma raw data: received 1 of 3 chunks/,
    );
  });

  test("decodeProformaDesign throws when a chunk position is missing from the observable set", () => {
    const [first, , third] = chunksFor({ title: "Gap" }, 3);

    assert.throws(
      () => decodeProformaDesign({ rawData: first }, [third]),
      /Incomplete ProForma raw data: received 2 of 3 chunks/,
    );
  });

  test("decodeProformaDesign throws on malformed part markers", () => {
    assert.throws(
      () => decodeProformaDesign({ rawData: { part: "first/2", data: "" } }, []),
      /Invalid ProForma raw-data chunk marker: first\/2/,
    );
  });

  test("decodeProformaDesign wraps invalid base64 JSON parse errors", () => {
    assert.throws(
      () => decodeProformaDesign({ rawData: { part: "1/1", data: "not-json" } }, []),
      /Failed to decode ProForma form design:/,
    );
  });

  test("decodeProformaDesign merges root and decoded design with decoded values and merged questions winning", () => {
    const [chunk] = chunksFor(
      { title: "Decoded title", questions: { shared: { label: "decoded" }, decodedOnly: { label: "new" } } },
      1,
    );

    const result = decodeProformaDesign(
      { rawData: chunk, design: { title: "Root title", rootOnly: true, questions: { shared: { label: "root" }, rootOnly: { label: "old" } } } },
      [],
    );

    assert.deepEqual(result, {
      title: "Decoded title",
      rootOnly: true,
      questions: {
        shared: { label: "decoded" },
        rootOnly: { label: "old" },
        decodedOnly: { label: "new" },
      },
    });
  });
});

describe("formatProformaAnswer", () => {
  test("formats plain text answers", () => {
    assert.equal(formatProformaAnswer({ text: "  hello world  " }, {}), "hello world");
  });

  test("resolves choice ids to labels and falls back to raw ids", () => {
    const question = { choices: [{ id: "a", label: "Alpha" }, { id: 2, label: "Two" }] };

    assert.equal(formatProformaAnswer({ choices: ["a", "missing", 2] }, question), "Alpha, missing, Two");
  });

  test("appends extra scalar keys", () => {
    assert.equal(formatProformaAnswer({ text: "Answer", extra: " detail ", count: 3, ok: false }, {}), "Answer | detail | 3 | false");
  });

  test("falls back to JSON for leftover non-scalar values", () => {
    assert.equal(formatProformaAnswer({ nested: { value: 1 }, list: ["x"] }, {}), JSON.stringify({ nested: { value: 1 }, list: ["x"] }));
  });

  test("returns an empty string when there is no meaningful answer content", () => {
    assert.equal(formatProformaAnswer({ text: " ", choices: [], empty: "", nil: null, list: [] }, {}), "");
  });
});
