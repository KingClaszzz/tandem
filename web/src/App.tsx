import { useEffect, useState } from "react";
import Landing from "./Landing";
import Dashboard from "./Dashboard";
import { useSpotlight } from "./ui";

const route = () => (location.hash.startsWith("#/app") ? "app" : "home");

export default function App() {
  const [r, setR] = useState(route);
  useSpotlight();
  useEffect(() => {
    const on = () => {
      const next = route();
      setR((prev) => {
        if (prev !== next) scrollTo(0, 0);
        return next;
      });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // In-page anchors (#how) must not trigger routing; keep them as plain scroll targets.
  useEffect(() => {
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[href^='#']") as HTMLAnchorElement | null;
      const h = a?.getAttribute("href");
      if (!h || h.startsWith("#/")) return;
      e.preventDefault();
      document.getElementById(h.slice(1))?.scrollIntoView({ behavior: "smooth" });
    };
    addEventListener("click", click);
    return () => removeEventListener("click", click);
  }, []);
  return r === "app" ? <Dashboard /> : <Landing />;
}
