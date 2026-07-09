import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1
      style={{
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: "1.25rem",
        fontWeight: 600,
        letterSpacing: "-0.015em",
        lineHeight: 1.3,
        color: "#d0d8c8",
        margin: "16px 0 8px 0",
      }}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2
      style={{
        fontFamily: '"Inter", sans-serif',
        fontSize: "1rem",
        fontWeight: 600,
        letterSpacing: "-0.01em",
        color: "#d0d8c8",
        margin: "16px 0 6px 0",
      }}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      style={{
        fontFamily: '"Inter", sans-serif',
        fontSize: "0.875rem",
        fontWeight: 600,
        color: "#d0d8c8",
        margin: "12px 0 4px 0",
      }}
      {...props}
    >
      {children}
    </h3>
  ),
  p: ({ children, ...props }) => (
    <p
      style={{
        fontFamily: '"Inter", sans-serif',
        fontSize: "0.8125rem",
        lineHeight: 1.6,
        color: "#d0d8c8",
        margin: "0 0 8px 0",
      }}
      {...props}
    >
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul
      style={{
        margin: "0 0 8px 0",
        paddingLeft: "20px",
        color: "#d0d8c8",
      }}
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      style={{
        margin: "0 0 8px 0",
        paddingLeft: "20px",
        color: "#d0d8c8",
      }}
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li
      style={{
        fontFamily: '"Inter", sans-serif',
        fontSize: "0.8125rem",
        lineHeight: 1.5,
        marginBottom: "2px",
        color: "#d0d8c8",
      }}
      {...props}
    >
      {children}
    </li>
  ),
  code: ({ children, className, ...props }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          style={{
            fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
            fontSize: "0.75rem",
            backgroundColor: "rgba(208, 216, 200, 0.06)",
            border: "1px solid rgba(208, 216, 200, 0.08)",
            borderRadius: "4px",
            padding: "1px 5px",
            color: "#e0c86a",
          }}
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <pre
        style={{
          margin: "0 0 10px 0",
          padding: "10px",
          backgroundColor: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(208, 216, 200, 0.1)",
          borderRadius: "8px",
          fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
          fontSize: "0.6875rem",
          lineHeight: 1.5,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "#d0d8c8",
        }}
      >
        <code className={className}>{children}</code>
      </pre>
    );
  },
  blockquote: ({ children, ...props }) => (
    <blockquote
      style={{
        margin: "0 0 8px 0",
        paddingLeft: "12px",
        borderLeft: "2px solid #c8a84a",
        color: "#7a8a72",
        fontStyle: "italic",
      }}
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      style={{
        color: "#c8a84a",
        textDecoration: "none",
        fontFamily: '"Inter", sans-serif',
        fontSize: "0.8125rem",
      }}
      {...props}
    >
      {children}
    </a>
  ),
  hr: () => (
    <hr
      style={{
        margin: "12px 0",
        border: "none",
        borderTop: "1px solid rgba(208, 216, 200, 0.1)",
      }}
    />
  ),
  strong: ({ children, ...props }) => (
    <strong style={{ fontWeight: 600, color: "#d0d8c8" }} {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em style={{ fontStyle: "italic" }} {...props}>
      {children}
    </em>
  ),
  table: ({ children, ...props }) => (
    <table
      style={{
        width: "100%",
        marginBottom: "8px",
        borderCollapse: "collapse",
        fontSize: "0.75rem",
        color: "#d0d8c8",
      }}
      {...props}
    >
      {children}
    </table>
  ),
  th: ({ children, ...props }) => (
    <th
      style={{
        textAlign: "left",
        fontWeight: 600,
        padding: "4px 8px",
        borderBottom: "1px solid rgba(208, 216, 200, 0.1)",
        color: "#7a8a72",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        fontSize: "0.6875rem",
      }}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      style={{
        padding: "4px 8px",
        borderBottom: "1px solid rgba(208, 216, 200, 0.1)",
        fontSize: "0.75rem",
        color: "#d0d8c8",
      }}
      {...props}
    >
      {children}
    </td>
  ),
};

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div>
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}
