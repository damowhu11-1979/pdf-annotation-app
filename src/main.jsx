import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// A simple error boundary so you see the crash on-screen (not blank)
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err) {
    console.error("App crashed:", err);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 16, fontFamily: "sans-serif" }}>
          <h2 style={{ color: "crimson" }}>App crashed</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {String(this.state.err?.stack || this.state.err)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
