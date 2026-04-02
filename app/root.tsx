import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import type { LinksFunction } from "react-router";
import stylesheet from "./app.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={{ fontFamily: "Inter, sans-serif", background: "#07070f", color: "white", minHeight: "100vh" }}>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status}: ${error.data}`
    : error instanceof Error
    ? error.message
    : String(error);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>App Error</title>
      </head>
      <body style={{ fontFamily: "monospace", background: "#07070f", color: "#f87171", padding: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Application Error</h1>
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "#1a1a2e", padding: "1rem", borderRadius: "0.5rem" }}>
          {message}
        </pre>
        {error instanceof Error && error.stack && (
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "#1a1a2e", padding: "1rem", borderRadius: "0.5rem", marginTop: "1rem", color: "#94a3b8", fontSize: "0.85rem" }}>
            {error.stack}
          </pre>
        )}
      </body>
    </html>
  );
}
