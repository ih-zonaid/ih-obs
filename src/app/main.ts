import { App } from "./app";

const mount = document.getElementById("app");
if (mount) {
  new App(mount);
}

// The shell is precached, so an installed copy starts with no network at all:
// the app is already in the cache and the vault is read from disk handles.
//
// Two guards. Extension pages cannot register a worker, so this is http(s)
// only; and dev is skipped because a worker serving cached bundles would
// shadow HMR. Test the offline path with `vite preview`, which serves dist.
if (import.meta.env.PROD && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker?.register("./sw.js").catch(() => {
      /* no offline shell, but the app still runs */
    });
  });
}
