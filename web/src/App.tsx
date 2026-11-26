import { Component, useEffect, useState, type ReactNode } from "react";
import Landing from "./Landing";
import Dashboard from "./Dashboard";
import Guide from "./Guide";
import { useReveal, useSpotlight } from "./ui";

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="wrap crash">
        <h1>Something went wrong on this page</h1>
        <p className="muted">The rest of the app is fine. Reload to try again.</p>
        <pre>{String(this.state.error.message).slice(0, 300)}</pre>
        <p><a className="btn btn-primary" href="#/" onClick={() => location.reload()}>Reload</a></p>
      </div>
    );
  }
}

const route = () => (location.hash.startsWith("#/app") ? "app" : location.hash.startsWith("#/guide") ? "guide" : "home");

export default function App() {
  const [r, setR] = useState(route);
  useSpotlight();
  useReveal();
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
  // In-page anchors (#loop) are scroll targets, not routes.
  useEffect(() => {
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[href^='#']") as HTMLAnchorElement | null;
      const h = a?.getAttribute("href");
      if (!h || h.startsWith("#/") || h === "#") return;
      e.preventDefault();
      document.getElementById(h.slice(1))?.scrollIntoView({ behavior: "smooth" });
    };
    addEventListener("click", click);
    return () => removeEventListener("click", click);
  }, []);
  return <Boundary key={r}>{r === "app" ? <Dashboard /> : r === "guide" ? <Guide /> : <Landing />}</Boundary>;
}
