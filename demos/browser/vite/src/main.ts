import "./style.css";
import { renderTodos } from "./todos";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app mount point.");

const main = document.createElement("main");
main.className = "grid min-h-svh place-items-center p-6";
main.append(renderTodos());
app.append(main);
