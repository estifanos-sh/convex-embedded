import "@blocknote/core/fonts/inter.css";
import "@blocknote/ariakit/style.css";
import "./style.css";

import { createRoot } from "react-dom/client";

import { App } from "./app";
import { client } from "./lib/client";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app mount point.");

createRoot(app).render(<App />);

if (import.meta.env.DEV) {
  void import("@convex-dev/embedded/devtools").then(({ mountEmbeddedDevtools }) => {
    mountEmbeddedDevtools(client, { defaultOpen: false });
  });
}
