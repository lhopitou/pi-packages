import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedContent } from "./storage.js";

const DOWNLOADS_DIR = join(homedir(), "Downloads");

export function isPDF(contentType: string, url: string): boolean {
  return (
    contentType.includes("application/pdf") ||
    url.toLowerCase().endsWith(".pdf")
  );
}

export async function extractPDFToMarkdown(
  url: string,
  buffer: Buffer,
): Promise<ExtractedContent> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const pages: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map(function (item: { str?: string }) {
          return item.str != null ? item.str : "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push(`## Page ${i}\n\n${text}`);
    }

    const content = pages.join("\n\n");
    const title = url.split("/").pop() || "document.pdf";

    // Save markdown copy
    const mdName = title.replace(/\.pdf$/i, ".md");
    const mdPath = join(DOWNLOADS_DIR, mdName);
    if (!existsSync(DOWNLOADS_DIR))
      mkdirSync(DOWNLOADS_DIR, { recursive: true });
    writeFileSync(mdPath, content + "\n");

    return {
      url,
      title: `PDF: ${title}`,
      content:
        content.length > 0
          ? content
          : "PDF appears to contain no extractable text (may be scanned/image-based).",
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      title: "",
      content: "",
      error: `PDF extraction failed: ${message}`,
    };
  }
}
