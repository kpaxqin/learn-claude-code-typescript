"use client";

import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";

hljs.registerLanguage("typescript", typescript);

interface SourceViewerProps {
  source: string;
  filename: string;
}

export function SourceViewer({ source, filename }: SourceViewerProps) {
  const { highlighted, lineCount } = useMemo(() => {
    const result = hljs.highlight(source, { language: "typescript" });
    return {
      highlighted: result.value,
      lineCount: source.split("\n").length,
    };
  }, [source]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          <span className="h-3 w-3 rounded-full bg-green-400" />
        </div>
        <span className="font-mono text-xs text-zinc-400">{filename}</span>
      </div>
      <div className="overflow-x-auto bg-zinc-950">
        <table className="min-w-full border-collapse">
          <tbody>
            <tr>
              <td className="sticky left-0 bg-zinc-950 select-none align-top">
                <pre className="p-2 pr-3 text-right text-[10px] leading-4 text-zinc-600 sm:p-4 sm:pr-4 sm:text-xs sm:leading-5">
                  {Array.from({ length: lineCount }, (_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </pre>
              </td>
              <td className="w-full align-top">
                <pre className="p-2 text-[10px] leading-4 text-zinc-200 sm:p-4 sm:text-xs sm:leading-5">
                  <code
                    className="hljs language-typescript"
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                  />
                </pre>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
