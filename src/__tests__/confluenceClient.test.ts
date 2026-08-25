import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeStorageMarkup, storageToPlainText } from "../confluenceClient.js";

describe("storageToPlainText", () => {
  test("converts paragraphs, line breaks, headings and list items", () => {
    const storage = "<h2>Title</h2><p>First<br/>Second</p><ul><li>One</li><li>Two</li></ul>";

    assert.equal(storageToPlainText(storage), "Title\n\nFirst\nSecond\n\n- One\n- Two");
  });

  test("unescapes HTML entities", () => {
    assert.equal(storageToPlainText("<p>A&nbsp;&amp;&nbsp;B &lt; C &gt; D &quot;quote&quot; &#39;apos&#39;</p>"), "A & B < C > D \"quote\" 'apos'");
  });

  test("renders anchors as label and URL and collapses duplicate or empty labels", () => {
    const storage = '<p><a href="https://example.test">Example</a> <a href="https://same.test">https://same.test</a> <a href="https://empty.test"></a></p>';

    assert.equal(storageToPlainText(storage), "Example (https://example.test) https://same.test https://empty.test");
  });

  test("renders Confluence page links as bracketed titles", () => {
    const storage = '<ac:link><ri:page ri:content-title="Runbook" /></ac:link>';

    assert.equal(storageToPlainText(storage), "[Runbook]");
  });

  test("renders self-closing and open structured macros as macro markers", () => {
    const storage = '<ac:structured-macro ac:name="toc"/><ac:structured-macro ac:name="info"><p>Body</p></ac:structured-macro>';

    assert.equal(storageToPlainText(storage), "[macro: toc]\n[macro: info]\nBody");
  });

  test("renders tables as pipe-delimited rows on separate lines", () => {
    const storage = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>1</td></tr></table>";

    assert.equal(storageToPlainText(storage), "| Name | Value |\n| Alpha | 1 |");
  });

  test("collapses excess blank lines and trims the result", () => {
    assert.equal(storageToPlainText("  <p>One</p><p></p><p>Two</p>  "), "One\n\nTwo");
  });
});

describe("looksLikeStorageMarkup", () => {
  test("recognizes real storage markup", () => {
    assert.equal(looksLikeStorageMarkup("<p>Text</p>"), true);
    assert.equal(looksLikeStorageMarkup("<strong>Text</strong>"), true);
    assert.equal(looksLikeStorageMarkup('<ac:structured-macro ac:name="toc"/>'), true);
    assert.equal(looksLikeStorageMarkup("Text</p>"), true);
  });

  test("does not misclassify ordinary prose with angle brackets as storage markup", () => {
    assert.equal(looksLikeStorageMarkup("a < b and c > d"), false);
    assert.equal(looksLikeStorageMarkup("use <placeholder> here"), false);
  });
});
