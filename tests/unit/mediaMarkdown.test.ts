import { describe, expect, it } from "vitest";

import { rewriteMediaLinesToMarkdown } from "@/lib/text/media-markdown";

describe("media-markdown", () => {
  it("rewrites MEDIA: lines pointing to images into markdown images", () => {
    const input = "Hello\nMEDIA: /home/ubuntu/.openclaw/workspace-agent/foo.png\nDone";
    const out = rewriteMediaLinesToMarkdown(input);

    expect(out).toContain("![](/api/runtime/media?path=");
    expect(out).toContain("MEDIA: /home/ubuntu/.openclaw/workspace-agent/foo.png");
    expect(out).toContain("Hello");
    expect(out).toContain("Done");
  });

  it("rewrites MEDIA: with the image path on the next line", () => {
    const input = "Hello\nMEDIA:\n/home/ubuntu/.openclaw/workspace-agent/foo.png\nDone";
    const out = rewriteMediaLinesToMarkdown(input);

    expect(out).toContain("![](/api/runtime/media?path=");
    expect(out).toContain("MEDIA: /home/ubuntu/.openclaw/workspace-agent/foo.png");
    expect(out).toContain("Hello");
    expect(out).toContain("Done");
  });

  it("does not rewrite inside fenced code blocks", () => {
    const input = "```\nMEDIA: /home/ubuntu/.openclaw/workspace-agent/foo.png\n```";
    const out = rewriteMediaLinesToMarkdown(input);
    expect(out).toBe(input);
  });

  it("leaves non-image MEDIA lines unchanged", () => {
    const input = "Hello\nMEDIA: /tmp/report.txt\nDone";
    const out = rewriteMediaLinesToMarkdown(input);
    expect(out).toBe(input);
  });

  it("does not consume the next line when MEDIA: is followed by non-image text", () => {
    const input = "Hello\nMEDIA:\n/tmp/report.txt\nDone";
    const out = rewriteMediaLinesToMarkdown(input);
    expect(out).toBe(input);
  });

  it("rewrites image paths with mixed-case extensions", () => {
    const input = "MEDIA: /home/ubuntu/.openclaw/workspace-agent/foo.PNG";
    const out = rewriteMediaLinesToMarkdown(input);
    expect(out).toContain("![](/api/runtime/media?path=");
    expect(out).toContain("MEDIA: /home/ubuntu/.openclaw/workspace-agent/foo.PNG");
  });
});
