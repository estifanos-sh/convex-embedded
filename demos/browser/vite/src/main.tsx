import "@blocknote/core/fonts/inter.css";
import "@blocknote/ariakit/style.css";
import "./style.css";

import { createRoot } from "react-dom/client";

import { App } from "./app";
import { client, clientReady } from "./lib/client";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app mount point.");

createRoot(app).render(<App />);

void clientReady.catch((error) => {
  console.error("Convex Embedded failed to open.", error);
});

if (import.meta.env.DEV) {
  void import("@convex-dev/embedded/devtools").then(({ mountEmbeddedDevtools }) => {
    mountEmbeddedDevtools(client, { defaultOpen: false });
  });
}
