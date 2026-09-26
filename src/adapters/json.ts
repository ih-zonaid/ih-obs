import { readText } from "../vault/fs";
import { isJson } from "../vault/tree";
import type { DocAdapter, DocView, LoadContext } from "./types";

function highlight(json: string): string {
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "json-key" : "json-str";
      else if (/true|false/.test(match)) cls = "json-bool";
      else if (/null/.test(match)) cls = "json-null";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export const jsonAdapter: DocAdapter = {
  kind: "json",
  matches: isJson,
  async load(ctx: LoadContext): Promise<DocView> {
    const raw = await readText(ctx.handle);
    let pretty = raw;
    let invalid = false;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      invalid = true;
    }

    const el = document.createElement("article");
    el.className = "json-view ihobs-surface";
    el.dataset.surface = "0";

    if (invalid) {
      el.classList.add("invalid");
      const note = document.createElement("div");
      note.className = "json-note";
      note.textContent = "invalid JSON — showing raw";
      el.appendChild(note);
    }

    const pre = document.createElement("pre");
    pre.className = "json-pre";
    pre.innerHTML = highlight(pretty);
    el.appendChild(pre);

    ctx.container.appendChild(el);

    return {
      kind: "json",
      path: ctx.path,
      surfaces: [{ index: 0, el, width: el.clientWidth, height: el.scrollHeight }],
      destroy() {
        el.remove();
      }
    };
  }
};
