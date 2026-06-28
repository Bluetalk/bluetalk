import React, { useMemo } from 'react';
import { NavLink, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ArrowLeft } from 'lucide-react';
import { DOCS_NAV, flattenDocsNav, docsPath } from './docsNav';
import 'highlight.js/styles/github-dark.css';
import './docs.css';

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function extractToc(markdown) {
  const headings = [];
  const lines = String(markdown || '').split('\n');
  for (const line of lines) {
    const match = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].replace(/#+$/, '').trim();
    headings.push({ level, text, id: slugify(text) });
  }
  return headings;
}

export default function DocsLayout({ slug, content, prev, next }) {
  const toc = useMemo(() => extractToc(content), [content]);

  const components = useMemo(() => ({
    h2: ({ children, ...props }) => {
      const id = slugify(Array.isArray(children) ? children.join('') : children);
      return <h2 id={id} {...props}>{children}</h2>;
    },
    h3: ({ children, ...props }) => {
      const id = slugify(Array.isArray(children) ? children.join('') : children);
      return <h3 id={id} {...props}>{children}</h3>;
    },
    a: ({ href, children, ...props }) => {
      if (href && href.startsWith('/docs/')) {
        return <Link to={href} {...props}>{children}</Link>;
      }
      return (
        <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer" {...props}>
          {children}
        </a>
      );
    },
  }), []);

  const flat = flattenDocsNav();
  const current = flat.find((item) => item.slug === slug);

  return (
    <div className="docs-shell">
      <aside className="docs-sidebar">
        <div className="docs-sidebar-header">
          <Link to="/plugins" className="docs-back-link">
            <ArrowLeft size={14} />
            Back to app
          </Link>
          <h1>Plugin API</h1>
          <p>BlueTalk extension developer docs</p>
        </div>
        <nav className="docs-nav" aria-label="Documentation">
          {DOCS_NAV.map((section) => (
            <div key={section.title} className="docs-nav-section">
              <div className="docs-nav-section-title">{section.title}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.slug}
                  to={docsPath(item.slug)}
                  className={({ isActive }) => `docs-nav-link${isActive ? ' active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="docs-main">
        <div className="docs-content-wrap">
          <div className="docs-breadcrumb">
            Docs
            {current ? (
              <>
                {' / '}
                <span>{current.section}</span>
                {' / '}
                <span>{current.label}</span>
              </>
            ) : null}
          </div>
          <article className="docs-prose">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={components}
            >
              {content}
            </ReactMarkdown>
          </article>
          {(prev || next) && (
            <div className="docs-pager">
              {prev ? (
                <Link to={docsPath(prev.slug)}>
                  <span>Previous</span>
                  ← {prev.label}
                </Link>
              ) : <span />}
              {next ? (
                <Link to={docsPath(next.slug)} style={{ textAlign: 'right', marginLeft: 'auto' }}>
                  <span>Next</span>
                  {next.label} →
                </Link>
              ) : null}
            </div>
          )}
        </div>

        {toc.length > 0 && (
          <aside className="docs-toc" aria-label="On this page">
            <div className="docs-toc-title">On this page</div>
            {toc.map((item) => (
              <a
                key={`${item.id}-${item.level}`}
                href={`#${item.id}`}
                className={`docs-toc-link level-${item.level}`}
              >
                {item.text}
              </a>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}
