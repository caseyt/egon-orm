import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { codepoints, graphemes, utf8Bytes } from "./measure.js";

describe("measuring strings", () => {
  test("graphemes matches Intl.Segmenter for any string", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-composite" }), fc.string({ unit: "binary" }), (a, b) => {
        for (const text of [a, b, `${a}\r\n${b}`]) {
          expect(graphemes(text)).toBe([...segmenter.segment(text)].length);
        }
      }),
    );
  });

  test("codepoints matches the string iterator", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        expect(codepoints(text)).toBe([...text].length);
      }),
    );
  });

  test("utf8Bytes matches TextEncoder", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        expect(utf8Bytes(text)).toBe(encoder.encode(text).length);
      }),
    );
    expect(utf8Bytes("\udc00")).toBe(3);
  });

  // The generated strings above are well formed and seldom sit on a boundary: these do.
  const edges = [
    "",
    "abc",
    "\u007f",
    "\u0080",
    "a\u0080",
    "߿",
    "ࠀ",
    "퟿",
    "",
    "\r",
    "a\r",
    "\r\n",
    "a\r\nb",
    "𐀀",
    "􏿿",
    "😀x",
    "x😀",
    "\ud800",
    "a\ud800",
    "\ud800a",
    "\udc00",
    "a\udc00",
    "\udc00\ud800",
    "\ud800𐀀",
    "\ud800\udbff",
    "퟿\udc00",
    "\ud800",
    "𐏿",
    "􏰀",
    "\udfff",
    "\ud800\u007f",
    "\udc00\udc00",
    "\udfff\udc00",
    "\udc00",
  ];

  test.each(edges.map((text) => [JSON.stringify(text), text]))("%s: all three measures", (_name, text) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    expect(graphemes(text)).toBe([...segmenter.segment(text)].length);
    expect(codepoints(text)).toBe([...text].length);
    expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
  });
});
