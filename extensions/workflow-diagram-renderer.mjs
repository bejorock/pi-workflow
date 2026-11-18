/** Disposable layout process: a third-party OOM must not crash the Pi host. */
import { renderMermaidASCII } from "beautiful-mermaid";
let source = "";
for await (const chunk of process.stdin) {
 source += chunk;
 if (source.length > 100_000) process.exit(2);
}
try {
 const rendered = renderMermaidASCII(source, {useAscii: false, colorMode: "none", paddingX: 2, paddingY: 2});
 process.stdout.write(JSON.stringify(rendered.length <= 250_000 ? {rendered} : {error: "Rendered diagram exceeds the 250 KiB preview limit."}));
} catch (error) {
 process.stdout.write(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
}
