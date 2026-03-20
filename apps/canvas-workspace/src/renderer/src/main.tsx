import { createRoot } from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = document.getElementById("root");
console.log("Renderer bootstrap", { rootFound: Boolean(root) });

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(<App />);
