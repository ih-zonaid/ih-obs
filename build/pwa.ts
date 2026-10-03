import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateSync } from "node:zlib";

// Everything below is generated from source — icons included — so the build
// keeps its zero-runtime-dependency shape and no binaries live in the repo.

type Rgb = readonly [number, number, number];

// Mirrors the dark palette in src/ui/styles.css, so the launcher icon and the
// installed window's chrome match what the app paints.
const BG: Rgb = [0x16, 0x18, 0x1d];
const FG: Rgb = [0xd7, 0xda, 0xe0];
const ACCENT: Rgb = [0x7a, 0xa2, 0xf7];
const THEME_DARK = "#16181d";

const SHORT_NAME = "ihobs";
const FULL_NAME = "ihobs";
const DESCRIPTION =
  "Minimal Obsidian-style vault reader with occlusion for active recall.";

// A page of text with one line banded by the accent: the app's own gesture,
// covered and then recalled. Every row sits inside the maskable safe circle
// (radius 0.4 from centre), so a single glyph serves all three icons.
const MARGIN = 0.22;
const ROWS: readonly { cy: number; h: number; x1: number; accent?: boolean }[] = [
  { cy: 0.295, h: 0.062, x1: 0.78 },
  { cy: 0.425, h: 0.062, x1: 0.64 },
  { cy: 0.565, h: 0.105, x1: 0.78, accent: true },
  { cy: 0.715, h: 0.062, x1: 0.55 }
];

function inRoundRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number
): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Which layer a point belongs to: 0 clear, 1 background, 2 text, 3 accent.
// Rows are pills, so a thin row's radius is half its height.
function layerAt(x: number, y: number, maskable: boolean): number {
  if (!maskable && !inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return 0;
  for (const row of ROWS) {
    const half = row.h / 2;
    if (inRoundRect(x, y, MARGIN, row.cy - half, row.x1, row.cy + half, half)) {
      return row.accent ? 3 : 2;
    }
  }
  return 1;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// A minimal 8-bit RGBA PNG encoder. Node's zlib supplies the only hard part.
function png(size: number, rgba: Buffer): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// 4x4 supersampling: the glyph is all edges, so box-filtering the layer
// coverage is what keeps 192px from looking like a staircase.
function renderIcon(size: number, maskable: boolean): Buffer {
  const SS = 4;
  const per = SS * SS;
  const cov = new Float32Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const base = (py * size + px) * 4;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          cov[base + layerAt(x, y, maskable)] += 1;
        }
      }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const bg = cov[i * 4 + 1] / per;
    const fg = cov[i * 4 + 2] / per;
    const accent = cov[i * 4 + 3] / per;
    const solid = bg + fg + accent;
    if (solid > 0) {
      out[i * 4] = Math.round((bg * BG[0] + fg * FG[0] + accent * ACCENT[0]) / solid);
      out[i * 4 + 1] = Math.round((bg * BG[1] + fg * FG[1] + accent * ACCENT[1]) / solid);
      out[i * 4 + 2] = Math.round((bg * BG[2] + fg * FG[2] + accent * ACCENT[2]) / solid);
    }
    out[i * 4 + 3] = Math.round((1 - cov[i * 4] / per) * 255);
  }
  return png(size, out);
}

function manifestJson(): string {
  return JSON.stringify(
    {
      name: FULL_NAME,
      short_name: SHORT_NAME,
      description: DESCRIPTION,
      start_url: "./",
      scope: "./",
      display: "standalone",
      background_color: THEME_DARK,
      theme_color: THEME_DARK,
      icons: [
        { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png" },
        {
          src: "./icons/icon-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable"
        }
      ]
    },
    null,
    2
  );
}

// The shell, as paths relative to the build root. Everything else in dist
// belongs to the extension target and is not part of the web app's cache.
//
// The worker is listed twice on purpose. The bundle resolves it through
// `import.meta.url` to assets/, and vite.config.ts also copies it to the root
// for the extension; only the first is known to be requested. Precaching both
// costs a duplicate 1.4 MB, which is the cheaper side of the bet — pdfjs has
// fallback paths that ask for the bare filename, and losing those offline would
// break the app's main feature. Drop the root entry once a browser confirms it
// is never fetched.
function shellFiles(outDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const rel = relative(outDir, path).split(sep).join("/");
        if (rel === "index.html" || rel === "pdf.worker.min.mjs" || rel.startsWith("assets/")) {
          found.push(rel);
        }
      }
    }
  };
  walk(outDir);
  return found.sort();
}

function serviceWorker(files: string[], rev: string): string {
  const shell = files.map((f) => `  "./${f}"`).join(",\n");
  return `// Generated by build/pwa.ts. Asset filenames carry no content hash of their
// own, so the cache name does: a rebuild that changes any byte of the shell
// installs a new worker, which drops the old cache on activate.
const CACHE = "ihobs-${rev}";
const SHELL = [
${shell}
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One at a time, so a single unreachable URL cannot leave the app with
      // no shell at all.
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Cache-first: the shell is the app, and nothing it renders comes off the
// network — vault content is read from disk handles, not fetched.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch {
        // A navigation the precache missed (a deep link with a query, say) still
        // gets the shell: any page is an entry point into a vault.
        if (req.mode === "navigate") {
          const shell = await cache.match(new URL("./index.html", self.registration.scope).href);
          if (shell) return shell;
        }
        return Response.error();
      }
    })()
  );
});
`;
}

export function writePwa(outDir: string): void {
  const icons = join(outDir, "icons");
  mkdirSync(icons, { recursive: true });
  writeFileSync(join(icons, "icon-192.png"), renderIcon(192, false));
  writeFileSync(join(icons, "icon-512.png"), renderIcon(512, false));
  writeFileSync(join(icons, "icon-maskable-512.png"), renderIcon(512, true));
  // Named .json rather than .webmanifest on purpose: a manifest must be served
  // with a JSON MIME type, and .json is the one extension every static host
  // (GitHub Pages included) is certain to map. It also keeps clear of the
  // extension's own manifest.json, which the same build emits.
  writeFileSync(join(outDir, "webmanifest.json"), manifestJson());

  const files = shellFiles(outDir);
  const hash = createHash("sha256");
  for (const rel of files) hash.update(rel).update(readFileSync(join(outDir, rel)));
  writeFileSync(join(outDir, "sw.js"), serviceWorker(files, hash.digest("hex").slice(0, 12)));
}
