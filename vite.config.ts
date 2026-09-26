import { defineConfig } from "vite";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";

const OUT = "dist";

function manifest() {
  return {
    manifest_version: 3,
    name: "ihobs",
    version: "0.1.0",
    description: "Minimal Obsidian-style vault reader with occlusion for active recall.",
    action: { default_title: "Open ihobs" },
    background: { service_worker: "background.js" },
    permissions: ["storage", "unlimitedStorage"],
    host_permissions: [],
    icons: {}
  };
}

function worker() {
  return `chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});`;
}

export default defineConfig({
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: "chrome114",
    rollupOptions: {
      input: { app: resolve(__dirname, "index.html") },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  plugins: [
    {
      name: "ihobs-manifest",
      closeBundle() {
        const out = resolve(__dirname, OUT);
        mkdirSync(out, { recursive: true });
        writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest(), null, 2));
        writeFileSync(resolve(out, "background.js"), worker());

        const html = resolve(out, "index.html");
        if (existsSync(html)) copyFileSync(html, resolve(out, "app.html"));

        const assets = resolve(out, "assets");
        if (existsSync(assets)) {
          const emitted = readdirSync(assets).find((f) => f.startsWith("pdf.worker"));
          if (emitted) copyFileSync(resolve(assets, emitted), resolve(out, "pdf.worker.min.mjs"));
        }

        const appHtml = readFileSync(resolve(out, "app.html"), "utf8").replace(
          /(src|href)="\/assets\//g,
          '$1="assets/'
        );
        writeFileSync(resolve(out, "app.html"), appHtml);
      }
    }
  ]
});
