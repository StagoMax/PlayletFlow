import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

export function MarkdownContent({ text }: { text: string }) {
  return (
    <Suspense fallback={<span style={{ whiteSpace: "pre-wrap" }}>{text}</span>}>
      <MarkdownRenderer text={text} />
    </Suspense>
  );
}
